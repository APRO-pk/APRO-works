//! Content-addressed blob store (DESIGN.md 5.4).
//!
//! Layout: `<root>/<first two hex chars of sha256>/<sha256>`.
//! Writes are temp-file + fsync + atomic rename, so a crash never leaves a
//! partially written blob visible under its final name.

use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};

use sha2::{Digest, Sha256};

use crate::error::Result;

pub fn content_hash(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex::encode(hasher.finalize())
}

/// True if `hash` looks like a sha256 hex digest. Guards against path traversal
/// from a hostile or corrupt database value.
fn is_valid_hash(hash: &str) -> bool {
    hash.len() == 64 && hash.chars().all(|c| c.is_ascii_hexdigit())
}

#[derive(Debug, Clone)]
pub struct BlobStore {
    root: PathBuf,
}

impl BlobStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn ensure(&self) -> Result<()> {
        fs::create_dir_all(&self.root)?;
        Ok(())
    }

    pub fn path_for(&self, hash: &str) -> Result<PathBuf> {
        if !is_valid_hash(hash) {
            return Err(crate::error::StoreError::invalid(format!(
                "refusing to resolve blob path for malformed hash {hash:?}"
            )));
        }
        Ok(self.root.join(&hash[..2]).join(hash))
    }

    /// Store bytes and return `(hash, len)`. Idempotent: storing the same bytes twice
    /// is a no-op after the first write.
    pub fn put(&self, bytes: &[u8]) -> Result<(String, u64)> {
        let hash = content_hash(bytes);
        let final_path = self.path_for(&hash)?;
        let len = bytes.len() as u64;

        if final_path.exists() {
            return Ok((hash, len));
        }

        let dir = final_path
            .parent()
            .ok_or_else(|| crate::error::StoreError::Config("blob path has no parent".into()))?;
        fs::create_dir_all(dir)?;

        let temp_path = dir.join(format!(".{hash}.tmp-{}", std::process::id()));
        {
            let mut file = fs::File::create(&temp_path)?;
            file.write_all(bytes)?;
            file.sync_all()?;
        }

        // Atomic within the same directory. If another process won the race, that is fine:
        // identical content, identical name.
        match fs::rename(&temp_path, &final_path) {
            Ok(()) => {}
            Err(_) if final_path.exists() => {
                let _ = fs::remove_file(&temp_path);
            }
            Err(err) => {
                let _ = fs::remove_file(&temp_path);
                return Err(err.into());
            }
        }

        Ok((hash, len))
    }

    pub fn get(&self, hash: &str) -> Result<Vec<u8>> {
        Ok(fs::read(self.path_for(hash)?)?)
    }

    pub fn contains(&self, hash: &str) -> bool {
        self.path_for(hash).map(|p| p.exists()).unwrap_or(false)
    }

    /// Remove a blob. Returns the number of bytes freed (0 if it was absent).
    pub fn remove(&self, hash: &str) -> Result<u64> {
        let path = self.path_for(hash)?;
        match fs::metadata(&path) {
            Ok(meta) => {
                let len = meta.len();
                fs::remove_file(&path)?;
                Ok(len)
            }
            Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(0),
            Err(err) => Err(err.into()),
        }
    }

    /// Enumerate stored blobs as `(hash, byte_size)`. Used by `doctor` and purge.
    pub fn list(&self) -> Result<Vec<(String, u64)>> {
        let mut out = Vec::new();
        if !self.root.exists() {
            return Ok(out);
        }
        for shard in fs::read_dir(&self.root)? {
            let shard = shard?;
            if !shard.file_type()?.is_dir() {
                continue;
            }
            for entry in fs::read_dir(shard.path())? {
                let entry = entry?;
                if !entry.file_type()?.is_file() {
                    continue;
                }
                let name = entry.file_name().to_string_lossy().to_string();
                if name.starts_with('.') || !is_valid_hash(&name) {
                    continue;
                }
                out.push((name, entry.metadata()?.len()));
            }
        }
        out.sort();
        Ok(out)
    }

    /// Remove blobs that no revision references. `referenced` is the live hash set
    /// gathered from the database.
    pub fn prune(&self, referenced: &std::collections::HashSet<String>) -> Result<(u64, u64)> {
        let mut removed = 0_u64;
        let mut freed = 0_u64;
        for (hash, size) in self.list()? {
            if referenced.contains(&hash) {
                continue;
            }
            fs::remove_file(self.path_for(&hash)?)?;
            removed += 1;
            freed += size;
        }
        Ok((removed, freed))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_malformed_hash_paths() {
        let store = BlobStore::new(std::env::temp_dir().join("apro-blob-test-guard"));
        assert!(store.path_for("../../etc/passwd").is_err());
        assert!(store.path_for("zz").is_err());
        assert!(store.path_for(&"a".repeat(64)).is_ok());
    }

    #[test]
    fn put_get_round_trip_is_content_addressed() {
        let dir = tempfile::tempdir().unwrap();
        let store = BlobStore::new(dir.path());
        store.ensure().unwrap();

        let (hash_a, len_a) = store.put(b"hello").unwrap();
        let (hash_b, _) = store.put(b"hello").unwrap();
        assert_eq!(hash_a, hash_b, "identical bytes must dedupe to one hash");
        assert_eq!(len_a, 5);
        assert_eq!(store.get(&hash_a).unwrap(), b"hello");

        let (hash_c, _) = store.put(b"different").unwrap();
        assert_ne!(hash_a, hash_c);
        // No temp files left behind.
        assert_eq!(store.list().unwrap().len(), 2);
    }
}
