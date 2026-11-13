// src-tauri/src/search.rs
// Embedded SQLite engine with FTS5 trigram search, knowledge graph backlinks,
// FSRS v5 spaced repetition, PDF indexing, and bidirectional audio-to-ink search bridge.

use r2d2::Pool;
use r2d2_sqlite::SqliteConnectionManager;
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::path::PathBuf;
use tauri::State;

pub type DbPool = Pool<SqliteConnectionManager>;

pub fn init_search_db(data_dir: PathBuf) -> Result<DbPool, String> {
    std::fs::create_dir_all(&data_dir).map_err(|e| e.to_string())?;
    let db_path = data_dir.join("search_index.db");
    let manager = SqliteConnectionManager::file(db_path).with_init(|c| {
        c.execute_batch("PRAGMA busy_timeout = 5000;")?;
        Ok(())
    });
    let pool = Pool::builder()
        .max_size(4)
        .min_idle(Some(1))
        .connection_timeout(std::time::Duration::from_secs(3))
        .build(manager)
        .map_err(|e| format!("Failed to create SQLite connection pool: {}", e))?;

    init_schema_on_pool(&pool)?;
    Ok(pool)
}

pub fn init_search_db_resilient(data_dir: PathBuf) -> DbPool {
    if let Ok(pool) = init_search_db(data_dir) {
        return pool;
    }
    if let Ok(pool) = init_search_db(std::env::temp_dir().join("GaussBoardSearch")) {
        return pool;
    }
    let mem_manager = SqliteConnectionManager::memory();
    if let Ok(pool) = Pool::builder().max_size(1).min_idle(Some(1)).build(mem_manager) {
        let _ = init_schema_on_pool(&pool);
        return pool;
    }
    Pool::builder()
        .max_size(1)
        .min_idle(Some(0))
        .build_unchecked(SqliteConnectionManager::memory())
}

fn init_schema_on_pool(pool: &DbPool) -> Result<(), String> {
    let conn = pool.get().map_err(|e| e.to_string())?;

    conn.execute_batch(
        "PRAGMA journal_mode = WAL;
         PRAGMA synchronous = NORMAL;
         PRAGMA temp_store = MEMORY;
         PRAGMA mmap_size = 268435456;
         PRAGMA busy_timeout = 5000;
         PRAGMA cache_size = -32000;

         -- 1. Trigram Full-Text Search Virtual Table
         CREATE VIRTUAL TABLE IF NOT EXISTS board_fts USING fts5(
             board_id UNINDEXED,
             title,
             content,
             tags,
             tokenize = 'trigram'
         );

         -- 2. Audio Transcript FTS5 Virtual Table
         CREATE VIRTUAL TABLE IF NOT EXISTS audio_fts USING fts5(
             board_id UNINDEXED,
             session_id UNINDEXED,
             word,
             start_ms UNINDEXED,
             end_ms UNINDEXED,
             tokenize = 'trigram'
         );

         -- 3. Stroke Temporal Map Table for Speech-to-Ink Linking
         CREATE TABLE IF NOT EXISTS stroke_temporal_map (
             board_id TEXT NOT NULL,
             session_id TEXT NOT NULL,
             stroke_id TEXT NOT NULL,
             t_start_ms INTEGER NOT NULL,
             t_end_ms INTEGER NOT NULL,
             center_x REAL NOT NULL,
             center_y REAL NOT NULL,
             width REAL NOT NULL,
             height REAL NOT NULL,
             PRIMARY KEY (board_id, stroke_id)
         );
         CREATE INDEX IF NOT EXISTS idx_stroke_session_time
             ON stroke_temporal_map (board_id, session_id, t_start_ms, t_end_ms);

         -- 4. Knowledge Graph Nodes and Edges
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

         -- 5. Spaced Repetition (SRS) Flashcards
         CREATE TABLE IF NOT EXISTS study_cards (
             card_id TEXT PRIMARY KEY,
             board_id TEXT NOT NULL,
             prompt TEXT NOT NULL,
             due_timestamp INTEGER NOT NULL,
             reps INTEGER DEFAULT 0,
             stability REAL DEFAULT 0.0,
             difficulty REAL DEFAULT 0.0
         );
         CREATE INDEX IF NOT EXISTS idx_study_cards_due ON study_cards(due_timestamp);

         -- 6. Per-Page PDF Full-Text Search Virtual Table
         CREATE VIRTUAL TABLE IF NOT EXISTS pdf_fts USING fts5(
             asset_id UNINDEXED,
             page_index UNINDEXED,
             doc_source,
             body,
             tokenize = 'trigram'
         );",
    )
    .map_err(|e| format!("Failed to initialize search schema: {}", e))?;

    Ok(())
}

#[derive(Serialize, Deserialize, Debug)]
pub struct SearchHit {
    pub board_id: String,
    pub title: String,
    pub snippet: String,
    pub rank: f64,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct AudioInkSearchHit {
    pub board_id: String,
    pub session_id: String,
    pub matched_word: String,
    pub audio_seek_ms: i64,
    pub stroke_id: String,
    pub camera_center_x: f32,
    pub camera_center_y: f32,
    pub bbox_width: f32,
    pub bbox_height: f32,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct AudioTokenInput {
    pub word: String,
    pub start_ms: i64,
    pub end_ms: i64,
}

#[derive(Serialize, Deserialize, Debug)]
pub struct StrokeTimingInput {
    pub stroke_id: String,
    pub t_start_ms: i64,
    pub t_end_ms: i64,
    pub center_x: f32,
    pub center_y: f32,
    pub width: f32,
    pub height: f32,
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

    let tag_str = tags.unwrap_or_default();
    conn.execute(
        "INSERT INTO board_fts (board_id, title, content, tags) VALUES (?1, ?2, ?3, ?4)",
        [&board_id, &title, &content, &tag_str],
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
    conn.execute("DELETE FROM graph_edges WHERE source_id = ? OR target_id = ?", [&board_id, &board_id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM stroke_temporal_map WHERE board_id = ?", [&board_id])
        .map_err(|e| e.to_string())?;
    conn.execute("DELETE FROM audio_fts WHERE board_id = ?", [&board_id])
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
    let lim = limit.unwrap_or(20);

    // Escape query tokens or wrap for trigram search
    let safe_query = query.replace('"', "\"\"");
    let fts_query = format!("\"{}\"", safe_query);

    let mut stmt = conn
        .prepare(
            "SELECT board_id, title, snippet(board_fts, 2, '<b>', '</b>', '...', 15) as snip, rank
             FROM board_fts
             WHERE board_fts MATCH ?1
             ORDER BY rank
             LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![fts_query, lim as i64], |row| {
            Ok(SearchHit {
                board_id: row.get(0)?,
                title: row.get(1)?,
                snippet: row.get(2)?,
                rank: row.get(3)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut results = Vec::new();
    for hit in rows.flatten() {
        results.push(hit);
    }
    Ok(results)
}

#[tauri::command]
pub fn search_audio_to_ink(
    pool: State<'_, DbPool>,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<AudioInkSearchHit>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let lim = limit.unwrap_or(25);

    let safe_query = query.replace('"', "\"\"");
    let fts_query = format!("\"{}\"", safe_query);

    let mut stmt = conn
        .prepare(
            "SELECT
                a.board_id,
                a.session_id,
                a.word,
                a.start_ms,
                s.stroke_id,
                s.center_x,
                s.center_y,
                s.width,
                s.height
             FROM audio_fts a
             JOIN stroke_temporal_map s
               ON s.board_id = a.board_id
              AND s.session_id = a.session_id
              AND s.t_end_ms >= (a.start_ms - 1500)
              AND s.t_start_ms <= (a.end_ms + 3500)
             WHERE audio_fts MATCH ?1
             ORDER BY ABS(((s.t_start_ms + s.t_end_ms) / 2) - ((a.start_ms + a.end_ms) / 2)) ASC
             LIMIT ?2",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map(params![fts_query, lim as i64], |row| {
            Ok(AudioInkSearchHit {
                board_id: row.get(0)?,
                session_id: row.get(1)?,
                matched_word: row.get(2)?,
                audio_seek_ms: row.get(3)?,
                stroke_id: row.get(4)?,
                camera_center_x: row.get(5)?,
                camera_center_y: row.get(6)?,
                bbox_width: row.get(7)?,
                bbox_height: row.get(8)?,
            })
        })
        .map_err(|e| e.to_string())?;

    let mut hits = Vec::new();
    for row in rows.flatten() {
        hits.push(row);
    }
    Ok(hits)
}

#[tauri::command]
pub fn record_stroke_temporal_map(
    pool: State<'_, DbPool>,
    board_id: String,
    session_id: String,
    strokes: Vec<StrokeTimingInput>,
) -> Result<usize, String> {
    let mut conn = pool.get().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let mut inserted = 0;
    {
        let mut stmt = tx
            .prepare(
                "INSERT OR REPLACE INTO stroke_temporal_map (
                    board_id, session_id, stroke_id, t_start_ms, t_end_ms, center_x, center_y, width, height
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            )
            .map_err(|e| e.to_string())?;

        for s in &strokes {
            stmt.execute(params![
                &board_id,
                &session_id,
                &s.stroke_id,
                s.t_start_ms,
                s.t_end_ms,
                s.center_x,
                s.center_y,
                s.width,
                s.height
            ])
            .map_err(|e| e.to_string())?;
            inserted += 1;
        }
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(inserted)
}

#[tauri::command]
pub fn index_audio_transcript(
    pool: State<'_, DbPool>,
    board_id: String,
    session_id: String,
    tokens: Vec<AudioTokenInput>,
) -> Result<usize, String> {
    let mut conn = pool.get().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    // Clear previous transcript tokens for this session
    let _ = tx.execute(
        "DELETE FROM audio_fts WHERE board_id = ? AND session_id = ?",
        [&board_id, &session_id],
    );

    let mut count = 0;
    {
        let mut stmt = tx
            .prepare("INSERT INTO audio_fts (board_id, session_id, word, start_ms, end_ms) VALUES (?1, ?2, ?3, ?4, ?5)")
            .map_err(|e| e.to_string())?;

        for t in &tokens {
            stmt.execute(params![&board_id, &session_id, &t.word, t.start_ms, t.end_ms])
                .map_err(|e| e.to_string())?;
            count += 1;
        }
    }

    tx.commit().map_err(|e| e.to_string())?;
    Ok(count)
}

#[tauri::command]
pub fn graph_record_links(
    pool: State<'_, DbPool>,
    board_id: String,
    board_title: String,
    targets: Vec<String>,
) -> Result<bool, String> {
    let mut conn = pool.get().map_err(|e| e.to_string())?;
    let tx = conn.transaction().map_err(|e| e.to_string())?;

    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64;

    tx.execute(
        "INSERT INTO graph_nodes (id, board_id, node_type, label, updated_at)
         VALUES (?1, ?1, 'board', ?2, ?3)
         ON CONFLICT(id) DO UPDATE SET label = excluded.label, updated_at = excluded.updated_at",
        params![board_id, board_title, now],
    ).map_err(|e| e.to_string())?;

    tx.execute("DELETE FROM graph_edges WHERE source_id = ?1", params![board_id])
        .map_err(|e| e.to_string())?;

    for target in targets {
        if target != board_id {
            tx.execute(
                "INSERT OR IGNORE INTO graph_edges (source_id, target_id, edge_type)
                 VALUES (?1, ?2, 'wikilink')",
                params![board_id, target],
            ).map_err(|e| e.to_string())?;
        }
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

    let mut stmt = conn.prepare(
        "SELECT n.board_id, n.label, e.edge_type
         FROM graph_edges e
         JOIN graph_nodes n ON n.id = e.source_id
         WHERE e.target_id = ?1",
    ).map_err(|e| e.to_string())?;

    let rows = stmt.query_map(params![board_id], |row| {
        Ok(BacklinkResult {
            source_board_id: row.get(0)?,
            source_title: row.get(1)?,
            edge_type: row.get(2)?,
        })
    }).map_err(|e| e.to_string())?;

    let mut results = Vec::new();
    for item in rows.flatten() {
        results.push(item);
    }
    Ok(results)
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
        "INSERT INTO study_cards (card_id, board_id, prompt, due_timestamp)
         VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(card_id) DO UPDATE SET due_timestamp = excluded.due_timestamp, prompt = excluded.prompt",
        params![card_id, board_id, prompt, due_timestamp],
    ).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
pub fn study_cards_due(
    pool: State<'_, DbPool>,
    now_timestamp: i64,
    limit: Option<usize>,
) -> Result<Vec<DueCardResult>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let lim = limit.unwrap_or(50);
    let mut stmt = conn.prepare(
        "SELECT card_id, board_id, prompt, due_timestamp
         FROM study_cards
         WHERE due_timestamp <= ?1
         ORDER BY due_timestamp ASC
         LIMIT ?2",
    ).map_err(|e| e.to_string())?;

    let rows = stmt.query_map(params![now_timestamp, lim as i64], |row| {
        Ok(DueCardResult {
            card_id: row.get(0)?,
            board_id: row.get(1)?,
            prompt: row.get(2)?,
            due_timestamp: row.get(3)?,
        })
    }).map_err(|e| e.to_string())?;

    let mut results = Vec::new();
    for card in rows.flatten() {
        results.push(card);
    }
    Ok(results)
}

#[tauri::command]
pub fn srs_schedule_card(
    pool: State<'_, DbPool>,
    card_id: String,
    board_id: String,
    prompt: String,
    interval_days: f64,
    stability: f64,
    difficulty: f64,
) -> Result<bool, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let due = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64 + (interval_days * 86400.0) as i64;

    conn.execute(
        "INSERT INTO study_cards (card_id, board_id, prompt, due_timestamp, reps, stability, difficulty)
         VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6)
         ON CONFLICT(card_id) DO UPDATE SET
            due_timestamp = excluded.due_timestamp,
            reps = reps + 1,
            stability = excluded.stability,
            difficulty = excluded.difficulty",
        params![card_id, board_id, prompt, due, stability, difficulty],
    ).map_err(|e| e.to_string())?;

    Ok(true)
}

#[tauri::command]
pub fn srs_get_due_cards(
    pool: State<'_, DbPool>,
) -> Result<Vec<DueCardResult>, String> {
    let conn = pool.get().map_err(|e| e.to_string())?;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;

    let mut stmt = conn.prepare(
        "SELECT card_id, board_id, prompt, due_timestamp
         FROM study_cards
         WHERE due_timestamp <= ?1
         ORDER BY due_timestamp ASC
         LIMIT 100",
    ).map_err(|e| e.to_string())?;

    let rows = stmt.query_map(params![now], |row| {
        Ok(DueCardResult {
            card_id: row.get(0)?,
            board_id: row.get(1)?,
            prompt: row.get(2)?,
            due_timestamp: row.get(3)?,
        })
    }).map_err(|e| e.to_string())?;

    let mut results = Vec::new();
    for card in rows.flatten() {
        results.push(card);
    }
    Ok(results)
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

    let asset_id = std::path::Path::new(&file_path)
        .file_stem()
        .and_then(|s| s.to_str())
        .map(|stem| format!("{}.pdf", stem))
        .unwrap_or_else(|| file_path.clone());
    let _ = tx.execute("DELETE FROM pdf_fts WHERE asset_id = ?", [&asset_id]);

    let mut indexed_count = 0;
    {
        let mut stmt = tx.prepare(
            "INSERT INTO board_fts(board_id, title, content, tags) VALUES (?, ?, ?, ?)"
        ).map_err(|e| e.to_string())?;
        let mut pdf_stmt = tx.prepare(
            "INSERT INTO pdf_fts(asset_id, page_index, doc_source, body) VALUES (?1, ?2, ?3, ?4)"
        ).map_err(|e| e.to_string())?;

        for (page_num, page_text) in &pages_data {
            let page_target_id = format!("{}#page={}", board_id, page_num);
            let page_title = format!("{} (Page {})", title, page_num);
            stmt.execute([&page_target_id, &page_title, page_text, &pdf_tags])
                .map_err(|e| format!("FTS insert failed on page {}: {}", page_num, e))?;
            let page_index = page_num.saturating_sub(1);
            pdf_stmt.execute(params![&asset_id, page_index, &title, page_text])
                .map_err(|e| format!("pdf_fts insert failed on page {}: {}", page_num, e))?;
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
