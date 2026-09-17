fn main() {
    // Must use CARGO_CFG_TARGET_OS: cfg!(target_os = "windows") is the *host*
    // in a build script, so a Windows→Android cross-compile would emit
    // -ladvapi32 and the NDK linker would fail.
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        println!("cargo:rustc-link-lib=advapi32");
    }
}
