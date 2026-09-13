fn main() {
    // 获取git commit SHA
    let commit_sha = std::process::Command::new("git")
        .args(&["rev-parse", "--short", "HEAD"])
        .output()
        .ok()
        .and_then(|output| {
            if output.status.success() {
                Some(String::from_utf8_lossy(&output.stdout).trim().to_string())
            } else {
                None
            }
        })
        .unwrap_or_else(|| String::from("unknown"));

    println!("cargo:rustc-env=COMMIT_SHA={}", commit_sha);

    // 构建目标三元组（如 x86_64-pc-windows-msvc），用于启动日志中记录构建信息
    let target = std::env::var("TARGET").unwrap_or_else(|_| String::from("unknown"));
    println!("cargo:rustc-env=BUILD_TARGET={}", target);

    tauri_build::build();
}
