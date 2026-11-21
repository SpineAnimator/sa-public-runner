/// A tiny public fixture to exercise the Ubuntu Rust toolchain.
pub fn linux_ci_ready() -> bool {
    cfg!(target_os = "linux")
}

#[cfg(test)]
mod tests {
    use super::linux_ci_ready;

    #[test]
    fn detects_linux_target() {
        assert!(linux_ci_ready());
    }
}
