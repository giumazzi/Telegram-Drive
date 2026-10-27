//! Child-process helpers shared by media, diagnostics and network probes.

/// Windows `CREATE_NO_WINDOW`. Without it every console helper (FFmpeg,
/// `ipconfig`) briefly opens a terminal window over the application.
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Prevents an asynchronous child process from opening a console window.
pub fn hide_console(command: &mut tokio::process::Command) {
    #[cfg(target_os = "windows")]
    {
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = command;
    }
}

/// Prevents a blocking child process from opening a console window.
pub fn hide_console_blocking(command: &mut std::process::Command) {
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    #[cfg(not(target_os = "windows"))]
    {
        let _ = command;
    }
}

/// Directories where package managers install command-line tools. macOS
/// opens applications from Finder or the Dock without them on the PATH, so an
/// FFmpeg installed with Homebrew or MacPorts would otherwise look missing.
#[cfg(target_os = "macos")]
const PACKAGE_MANAGER_BIN_DIRECTORIES: &[&str] =
    &["/opt/homebrew/bin", "/usr/local/bin", "/opt/local/bin"];
#[cfg(not(target_os = "macos"))]
const PACKAGE_MANAGER_BIN_DIRECTORIES: &[&str] = &[];

fn package_manager_bin_directories() -> Vec<std::path::PathBuf> {
    // Native journeys substitute a private directory for the macOS locations.
    #[cfg(feature = "native-e2e")]
    if let Some(directories) = std::env::var_os("TELEGRAM_DRIVE_E2E_TOOL_DIRECTORIES") {
        return std::env::split_paths(&directories).collect();
    }
    PACKAGE_MANAGER_BIN_DIRECTORIES
        .iter()
        .map(std::path::PathBuf::from)
        .collect()
}

/// FFmpeg executables to try after a bundled one: the PATH lookup first, then
/// each installed copy in a package-manager directory the PATH may lack.
pub fn ffmpeg_candidates() -> Vec<std::path::PathBuf> {
    let mut candidates = vec![std::path::PathBuf::from("ffmpeg")];
    candidates.extend(
        package_manager_bin_directories()
            .into_iter()
            .map(|directory| directory.join("ffmpeg"))
            .filter(|candidate| candidate.is_file()),
    );
    candidates
}
