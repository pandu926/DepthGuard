fn main() {
    // Stable Rust must rebuild the embedded migrator when new migration files are added.
    println!("cargo:rerun-if-changed=../../migrations");
}
