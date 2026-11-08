// src-tauri/src/bundle.rs
use sha2::{Digest, Sha256};
use std::fs::File;
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::{Path, PathBuf};
use zip::write::SimpleFileOptions;
use zip::{CompressionMethod, ZipArchive, ZipWriter};

pub struct HashingWriter<W: Write> {
    inner: W,
    hasher: Sha256,
    bytes_written: u64,
}

impl<W: Write> HashingWriter<W> {
    pub fn new(inner: W) -> Self {
        Self {
            inner,
            hasher: Sha256::new(),
            bytes_written: 0,
        }
    }
    pub fn finalize_sha256(self) -> (W, String, u64) {
        let hash = hex::encode(self.hasher.finalize());
        (self.inner, hash, self.bytes_written)
    }
}

impl<W: Write> Write for HashingWriter<W> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let n = self.inner.write(buf)?;
        self.hasher.update(&buf[..n]);
        self.bytes_written += n as u64;
        Ok(n)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

#[derive(serde::Serialize, serde::Deserialize, Debug)]
pub struct BundleExportResult {
    pub archive_path: String,
    pub total_bytes: u64,
    pub sha256: String,
}

#[derive(serde::Serialize, serde::Deserialize, Debug)]
pub struct BundleImportResult {
    pub extracted_dir: String,
    pub files_count: usize,
    pub sha256: String,
}

#[tauri::command]
pub async fn bundle_export(
    source_dir: String,
    dest_zip_path: String,
    use_zstd: Option<bool>,
) -> Result<BundleExportResult, String> {
    tokio::task::spawn_blocking(move || {
        let src_path = Path::new(&source_dir);
        if !src_path.exists() {
            return Err(format!("Source directory does not exist: {}", source_dir));
        }

        let out_file = File::create(&dest_zip_path)
            .map_err(|e| format!("Failed to create destination file: {}", e))?;
        let buf_writer = BufWriter::with_capacity(128 * 1024, out_file);
        let mut hashing_writer = HashingWriter::new(buf_writer);

        let compression = if use_zstd.unwrap_or(false) {
            CompressionMethod::Zstd
        } else {
            CompressionMethod::Deflated
        };

        let file_options = SimpleFileOptions::default()
            .compression_method(compression)
            .unix_permissions(0o644);

        let mut zip = ZipWriter::new(&mut hashing_writer);

        for entry in walkdir::WalkDir::new(src_path).into_iter().filter_map(|e| e.ok()) {
            let path = entry.path();
            let relative = path
                .strip_prefix(src_path)
                .map_err(|e| format!("Failed to compute relative path: {}", e))?;
            let name = relative.to_string_lossy().replace('\\', "/");

            if name.is_empty() {
                continue;
            }

            if path.is_file() {
                zip.start_file(&name, file_options)
                    .map_err(|e| format!("Failed to start zip file entry {}: {}", name, e))?;
                let mut f = File::open(path)
                    .map_err(|e| format!("Failed to open file {}: {}", path.display(), e))?;
                let mut buf = [0u8; 64 * 1024];
                loop {
                    let n = f
                        .read(&mut buf)
                        .map_err(|e| format!("Failed to read chunk from {}: {}", path.display(), e))?;
                    if n == 0 {
                        break;
                    }
                    zip.write_all(&buf[..n])
                        .map_err(|e| format!("Failed to write chunk to zip: {}", e))?;
                }
            } else if path.is_dir() {
                zip.add_directory(&name, file_options)
                    .map_err(|e| format!("Failed to add directory entry {}: {}", name, e))?;
            }
        }

        zip.finish()
            .map_err(|e| format!("Failed to finalize zip archive: {}", e))?;
        let (_, hash, bytes) = hashing_writer.finalize_sha256();

        Ok(BundleExportResult {
            archive_path: dest_zip_path,
            total_bytes: bytes,
            sha256: hash,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn bundle_import(archive_path: String, target_dir: String) -> Result<BundleImportResult, String> {
    tokio::task::spawn_blocking(move || {
        let file = File::open(&archive_path)
            .map_err(|e| format!("Failed to open archive {}: {}", archive_path, e))?;
        
        let mut hasher = Sha256::new();
        let mut f_read = File::open(&archive_path)
            .map_err(|e| format!("Failed to open archive for hashing: {}", e))?;
        let mut hash_buf = [0u8; 64 * 1024];
        loop {
            let n = f_read.read(&mut hash_buf).map_err(|e| e.to_string())?;
            if n == 0 { break; }
            hasher.update(&hash_buf[..n]);
        }
        let sha256_hash = hex::encode(hasher.finalize());

        let mut archive = ZipArchive::new(BufReader::new(file))
            .map_err(|e| format!("Failed to read zip archive: {}", e))?;
        let out_base = PathBuf::from(&target_dir);
        let mut files_count = 0;

        for i in 0..archive.len() {
            let mut file = archive
                .by_index(i)
                .map_err(|e| format!("Failed to read entry #{}: {}", i, e))?;

            // ZipSlip prevention: ensure the target path is strictly within out_base
            let sanitized_path = match file.enclosed_name() {
                Some(p) => out_base.join(p),
                None => {
                    return Err(format!(
                        "Security error: malicious ZipSlip path detected in archive: {}",
                        file.name()
                    ))
                }
            };

            if file.is_dir() {
                std::fs::create_dir_all(&sanitized_path)
                    .map_err(|e| format!("Failed to create directory {}: {}", sanitized_path.display(), e))?;
            } else {
                if let Some(parent) = sanitized_path.parent() {
                    std::fs::create_dir_all(parent)
                        .map_err(|e| format!("Failed to create parent dir: {}", e))?;
                }
                let mut outfile = File::create(&sanitized_path)
                    .map_err(|e| format!("Failed to create target file {}: {}", sanitized_path.display(), e))?;
                io::copy(&mut file, &mut outfile)
                    .map_err(|e| format!("Failed to extract file contents: {}", e))?;
                files_count += 1;
            }
        }

        Ok(BundleImportResult {
            extracted_dir: target_dir,
            files_count,
            sha256: sha256_hash,
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
