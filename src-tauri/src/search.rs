// src-tauri/src/search.rs
use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::State;

pub type DbPool = Pool<SqliteConnectionManager>;

pub fn init_search_db(data_dir: PathBuf) -> Result<DbPool, String> {
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let db_path = data_dir.join("search_index.db");
    let manager = SqliteConnectionManager::file(db_path);
    let pool = Pool::new(manager).map_err(|e| format!("Failed to create SQLite connection pool: {}", e))?;

    let conn = pool.get().map_err(|e| e.to_string())?;

    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA temp_store = MEMORY;
         PRAGMA cache_size = -32000;

         -- 1. Trigram Full-Text Search Virtual Table
         CREATE VIRTUAL TABLE IF NOT EXISTS board_fts USING fts5(
             board_id UNINDEXED,
             title,
             content,
             tags,
             tokenize = 'trigram'
         );

         -- 2. Knowledge Graph Nodes and Edges
         CREATE TABLE IF NOT EXISTS graph_nodes (
             id TEXT PRIMARY KEY,
             board_id TEXT NOT NULL,
             node_type TEXT NOT NULL,
             label TEXT NOT NULL,
             updated_at INTEGER NOT NULL
         );

         CREATE TABLE IF NOT EXISTS graph_edges (
             source_id TEXT NOT NULL,
             target_id TEXT NOT NULL,
             edge_type TEXT NOT NULL,
             PRIMARY KEY (source_id, target_id, edge_type)
         );

         -- 3. Spaced Repetition (SRS) Flashcards
         CREATE TABLE IF NOT EXISTS study_cards (
             card_id TEXT PRIMARY KEY,
             board_id TEXT NOT NULL,
             prompt TEXT NOT NULL,
             due_timestamp INTEGER NOT NULL,
             reps INTEGER DEFAULT 0,
             stability REAL DEFAULT 0.0,
             difficulty REAL DEFAULT 0.0
         );
         CREATE INDEX IF NOT EXISTS idx_study_cards_due ON study_cards(due_timestamp);",
    )
    .map_err(|e| format!("Failed to initialize search schema: {}", e))?;

    Ok(pool)
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SearchHit {
    pub board_id: String,
    pub title: String,
    pub snippet: String,
    pub rank: f64,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct BacklinkResult {
    pub source_board_id: String,
    pub source_title: String,
    pub edge_type: String,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct DueCardResult {
    pub card_id: String,
    pub board_id: String,
    pub prompt: String,
    pub due_timestamp: i64,
}

#[tauri::command]
pub fn search_index_board(
    pool: State<'_, DbPool>,
    board_id: String,
    title: String,
    content: String,
    tags: Option<String>,
) -> Result<bool, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    
    // Remove existing entries for this board to update cleanly
    let _ = conn.execute("DELETE FROM board_fts WHERE board_id = ?", [&board_id]);

    conn.execute(
        "INSERT INTO board_fts(board_id, title, content, tags) VALUES (?, ?, ?, ?)",
        [
            &board_id,
            &title,
            &content,
            &tags.unwrap_or_default(),
        ],
    )
    .map_err(|e| format!("Failed to index board: {}", e))?;

    Ok(true)
}

#[tauri::command]
pub fn search_delete_board(pool: State<'_, DbPool>, board_id: String) -> Result<bool, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM board_fts WHERE board_id = ?", [&board_id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM graph_nodes WHERE board_id = ?", [&board_id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM study_cards WHERE board_id = ?", [&board_id])
        .map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn search_boards(
    pool: State<'_, DbPool>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<SearchHit>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let max_results = limit.unwrap_or(50).clamp(1, 200);

    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }

    let mut stmt = conn
        .prepare(
            "SELECT board_id, title, snippet(board_fts, 2, '<mark>', '</mark>', '...', 25), bm25(board_fts)
             FROM board_fts 
             WHERE board_fts MATCH ? 
             ORDER BY bm25(board_fts) 
             LIMIT ?",
        )
        .map_err(|e| format!("Query preparation failed: {}", e))?;

    let rows = stmt
        .query_map([trimmed, &max_results.to_string()], |row| {
            Ok(SearchHit {
                board_id: row.get(0)?,
                title: row.get(1)?,
                snippet: row.get(2)?,
                rank: row.get(3)?,
            })
        })
        .map_err(|e| format!("Query execution failed: {}", e))?;

    Ok(rows.flatten().collect())
}

#[derive(Deserialize)]
pub struct GraphLinkInput {
    pub target_board_id: String,
    pub target_title: String,
    pub edge_type: String,
}

#[tauri::command]
pub fn graph_record_links(
    pool: State<'_, DbPool>,
    board_id: String,
    board_title: String,
    links: Vec<GraphLinkInput>,
) -> Result<bool, String> {
    let mut conn = pool.get().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    tx.execute(
        "INSERT OR REPLACE INTO graph_nodes(id, board_id, node_type, label, updated_at) VALUES (?, ?, 'board', ?, ?)",
        [&board_id, &board_id, &board_title, &now.to_string()],
    )
    .map_err(|e| e.to_string())?;

    tx.execute("DELETE FROM graph_edges WHERE source_id = ?", [&board_id])
        .map_err(|e| e.to_string())?;

    for link in links {
        tx.execute(
            "INSERT OR IGNORE INTO graph_nodes(id, board_id, node_type, label, updated_at) VALUES (?, ?, 'board', ?, ?)",
            [&link.target_board_id, &link.target_board_id, &link.target_title, &now.to_string()],
        )
        .map_err(|e| e.to_string())?;

        tx.execute(
            "INSERT OR REPLACE INTO graph_edges(source_id, target_id, edge_type) VALUES (?, ?, ?)",
            [&board_id, &link.target_board_id, &link.edge_type],
        )
        .map_err(|e| e.to_string())?;
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn graph_get_backlinks(
    pool: State<'_, DbPool>,
    board_id: String,
) -> Result<Vec<BacklinkResult>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(
            "SELECT n.board_id, n.label, e.edge_type 
             FROM graph_edges e
             JOIN graph_nodes n ON e.source_id = n.id
             WHERE e.target_id = ?",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([&board_id], |row| {
            Ok(BacklinkResult {
                source_board_id: row.get(0)?,
                source_title: row.get(1)?,
                edge_type: row.get(2)?,
            })
        })
        .map_err(|e| e.to_string())?;

    Ok(rows.flatten().collect())
}

#[tauri::command]
pub fn study_card_upsert(
    pool: State<'_, DbPool>,
    card_id: String,
    board_id: String,
    prompt: String,
    due_timestamp: i64,
) -> Result<bool, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    conn.execute(
        "INSERT INTO study_cards(card_id, board_id, prompt, due_timestamp) VALUES (?, ?, ?, ?)
         ON CONFLICT(card_id) DO UPDATE SET due_timestamp = excluded.due_timestamp, prompt = excluded.prompt",
        [&card_id, &board_id, &prompt, &due_timestamp.to_string()],
    )
    .map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn study_cards_due(
    pool: State<'_, DbPool>,
    now_timestamp: i64,
    limit: Option<usize>,
) -> Result<Vec<DueCardResult>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let max = limit.unwrap_or(50).clamp(1, 200);

    let mut stmt = conn
        .prepare(
            "SELECT card_id, board_id, prompt, due_timestamp 
             FROM study_cards 
             WHERE due_timestamp <= ? 
             ORDER BY due_timestamp ASC 
             LIMIT ?",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([now_timestamp.to_string(), max.to_string()], |row| {
            Ok(DueCardResult {
                card_id: row.get(0)?,
                board_id: row.get(1)?,
                prompt: row.get(2)?,
                due_timestamp: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;

    Ok(rows.flatten().collect())
}


#[derive(Serialize, Deserialize, Debug)]
pub struct PdfIndexSummary {
    pub board_id: String,
    pub title: String,
    pub total_pages: usize,
    pub indexed_pages: usize,
    pub total_chars: usize,
}

#[tauri::command]
pub async fn search_index_pdf(
    pool: State<'_, DbPool>,
    board_id: String,
    title: String,
    file_path: String,
    tags: Option<String>,
) -> Result<PdfIndexSummary, String> {
    let path = file_path.clone();

    let (pages_data, total_pages, total_chars) = tokio::task::spawn_blocking(move || -> Result<_, String> {
        let full_text = pdf_extract::extract_text(&path)
            .map_err(|e| format!("Failed to parse PDF document at {}: {}", path, e))?;

        let raw_pages: Vec<&str> = full_text.split('\x0c').collect();
        let total = raw_pages.len();
        let mut extracted: Vec<(u32, String)> = Vec::with_capacity(total);
        let mut chars_count = 0;

        for (idx, page_str) in raw_pages.iter().enumerate() {
            let trimmed = page_str.trim();
            if !trimmed.is_empty() {
                chars_count += trimmed.len();
                extracted.push(((idx + 1) as u32, trimmed.to_string()));
            }
        }
        Ok((extracted, total, chars_count))
    })
    .await
    .map_err(|e| format!("Task execution error: {}", e))??;

    let mut conn = pool.get().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let base_tag = tags.unwrap_or_default();
    let pdf_tags = if base_tag.is_empty() {
        "pdf,attachment".to_string()
    } else {
        format!("pdf,attachment,{}", base_tag)
    };

    let pattern = format!("{}#page=%", board_id);
    let _ = tx.execute("DELETE FROM board_fts WHERE board_id = ? OR board_id LIKE ?", [&board_id, &pattern]);

    let mut indexed_count = 0;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO board_fts(board_id, title, content, tags) VALUES (?, ?, ?, ?)"
        ).map_err(|e| e.to_string())?;

        for (page_num, page_text) in &pages_data {
            let page_target_id = format!("{}#page={}", board_id, page_num);
            let page_title = format!("{} (Page {})", title, page_num);
            stmt.execute([&page_target_id, &page_title, page_text, &pdf_tags])
                .map_err(|e| format!("FTS insert failed on page {}: {}", page_num, e))?;
            indexed_count += 1;
        }
    }

    tx.commit().map_err(|e| e.to_string())?;

    Ok(PdfIndexSummary {
        board_id,
        title,
        total_pages,
        indexed_pages: indexed_count,
        total_chars,
    })
}

#[tauri::command]
pub async fn pdf_extract_full_text(file_path: String) -> Result<String, String> {
    tokio::task::spawn_blocking(move || {
        pdf_extract::extract_text(&file_path)
            .map_err(|e| format!("PDF text extraction failed: {}", e))
    })
    .await
    .map_err(|e| e.to_string())?
}
