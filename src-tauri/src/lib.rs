use std::ffi::OsString;
use std::fs::File;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

const KOUBO_RUNTIME_DISTRO: &str = "KouboRuntime";
const KOUBO_RUNTIME_MANIFEST_PATH: &str = "/etc/koubo-runtime.json";
const KOUBO_RUNTIME_EXECUTABLE_PATH: &str = "/opt/koubo/bin/koubo-runtime";
const MIN_RUNTIME_TAR_BYTES: u64 = 1024 * 1024;
const RUNTIME_HASH_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const WSL_PROBE_TIMEOUT: Duration = Duration::from_secs(30);
const WSL_IMPORT_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const WSL_CONTROLLER_TIMEOUT: Duration = Duration::from_secs(120);

static RUNTIME_OPERATION_ACTIVE: AtomicBool = AtomicBool::new(false);

#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeImportError {
    code: &'static str,
    message: String,
}

impl RuntimeImportError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    fn from_wsl_command(
        error: WslCommandError,
        failure_code: &'static str,
        timeout_code: &'static str,
        failure_message: impl FnOnce(std::io::Error) -> String,
        timeout_message: &'static str,
    ) -> Self {
        match error {
            WslCommandError::Io(error) => Self::new(failure_code, failure_message(error)),
            WslCommandError::Timeout => Self::new(timeout_code, timeout_message),
        }
    }
}

#[derive(Debug)]
enum WslCommandError {
    Io(std::io::Error),
    Timeout,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuntimeCleanupScope {
    CreatedDirectoryOnly,
    ImportedDistro,
}

impl RuntimeCleanupScope {
    fn may_unregister(self) -> bool {
        matches!(self, Self::ImportedDistro)
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeImportResponse {
    status: &'static str,
    source: &'static str,
    distro_name: &'static str,
    version: Option<String>,
    sha256: Option<String>,
    message: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct RuntimePackageSnapshot {
    size: u64,
    modified: std::time::SystemTime,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct KouboRuntimeManifest {
    schema_version: u32,
    name: String,
    version: String,
    api_url: String,
}

struct RuntimeOperationGuard;

impl RuntimeOperationGuard {
    fn acquire(code: &'static str, message: &'static str) -> Result<Self, RuntimeImportError> {
        RUNTIME_OPERATION_ACTIVE
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| RuntimeImportError::new(code, message))?;
        Ok(Self)
    }
}

impl Drop for RuntimeOperationGuard {
    fn drop(&mut self) {
        RUNTIME_OPERATION_ACTIVE.store(false, Ordering::Release);
    }
}

fn runtime_install_dir(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("runtime").join(KOUBO_RUNTIME_DISTRO)
}

fn validate_runtime_tar(path: &Path) -> Result<PathBuf, RuntimeImportError> {
    let canonical = path.canonicalize().map_err(|error| {
        RuntimeImportError::new("package_unreadable", format!("无法读取所选运行包：{error}"))
    })?;
    let metadata = canonical.metadata().map_err(|error| {
        RuntimeImportError::new("package_unreadable", format!("无法检查所选运行包：{error}"))
    })?;
    if !metadata.is_file() {
        return Err(RuntimeImportError::new(
            "package_invalid",
            "请选择普通的 .tar 文件。",
        ));
    }
    if canonical
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| !value.eq_ignore_ascii_case("tar"))
        .unwrap_or(true)
    {
        return Err(RuntimeImportError::new(
            "package_invalid",
            "运行包必须是 .tar 文件。",
        ));
    }
    if metadata.len() < MIN_RUNTIME_TAR_BYTES {
        return Err(RuntimeImportError::new(
            "package_invalid",
            "运行包小于 1 MiB，文件可能不完整。",
        ));
    }
    Ok(canonical)
}

fn runtime_checksum_path(tar_path: &Path) -> PathBuf {
    let mut value = tar_path.as_os_str().to_os_string();
    value.push(".sha256");
    PathBuf::from(value)
}

fn parse_runtime_checksum_file(bytes: &[u8]) -> Result<String, RuntimeImportError> {
    let digest_bytes = match bytes {
        [digest @ .., b'\n'] if digest.len() == 64 => digest,
        [digest @ .., b'\r', b'\n'] if digest.len() == 64 => digest,
        _ => {
            return Err(RuntimeImportError::new(
                "package_checksum_invalid",
                "摘要文件格式无效：只允许一行小写 SHA-256，并以换行结束。",
            ))
        }
    };
    if !digest_bytes
        .iter()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(byte))
    {
        return Err(RuntimeImportError::new(
            "package_checksum_invalid",
            "摘要文件格式无效：只允许一行小写 SHA-256，并以换行结束。",
        ));
    }
    Ok(String::from_utf8(digest_bytes.to_vec()).expect("ASCII digest is valid UTF-8"))
}

fn read_runtime_expected_checksum(tar_path: &Path) -> Result<String, RuntimeImportError> {
    let checksum_path = runtime_checksum_path(tar_path);
    let metadata = std::fs::metadata(&checksum_path).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            RuntimeImportError::new(
                "package_checksum_missing",
                format!(
                    "缺少摘要文件 {}。请把它与运行包放在同一目录。",
                    checksum_path.display()
                ),
            )
        } else {
            RuntimeImportError::new(
                "package_checksum_unreadable",
                format!("无法读取运行包摘要文件：{error}"),
            )
        }
    })?;
    if !metadata.is_file() || !matches!(metadata.len(), 65 | 66) {
        return Err(RuntimeImportError::new(
            "package_checksum_invalid",
            "摘要文件格式无效：只允许一行小写 SHA-256，并以换行结束。",
        ));
    }
    let bytes = std::fs::read(&checksum_path).map_err(|error| {
        RuntimeImportError::new(
            "package_checksum_unreadable",
            format!("无法读取运行包摘要文件：{error}"),
        )
    })?;
    parse_runtime_checksum_file(&bytes)
}

fn parse_certutil_sha256_output(bytes: &[u8]) -> Result<String, RuntimeImportError> {
    let output = decode_wsl_text(bytes);
    let candidates = output
        .split(|character: char| !character.is_ascii_hexdigit())
        .filter(|candidate| candidate.len() == 64)
        .collect::<Vec<_>>();
    if candidates.len() != 1 {
        return Err(RuntimeImportError::new(
            "package_checksum_output_invalid",
            "Windows 摘要工具没有返回唯一、有效的 SHA-256。",
        ));
    }
    Ok(candidates[0].to_ascii_lowercase())
}

#[cfg(windows)]
fn certutil_executable_path() -> Result<PathBuf, RuntimeImportError> {
    let system_root = std::env::var_os("SystemRoot").ok_or_else(|| {
        RuntimeImportError::new(
            "package_checksum_tool_unavailable",
            "Windows SystemRoot 不可用，无法定位系统摘要工具。",
        )
    })?;
    let path = PathBuf::from(system_root)
        .join("System32")
        .join("certutil.exe");
    if !path.is_file() {
        return Err(RuntimeImportError::new(
            "package_checksum_tool_unavailable",
            "未找到 Windows 系统摘要工具 certutil.exe。",
        ));
    }
    Ok(path)
}

fn certutil_hash_args(tar_path: &Path) -> Vec<OsString> {
    vec![
        "-hashfile".into(),
        tar_path.as_os_str().to_owned(),
        "SHA256".into(),
    ]
}

#[cfg(windows)]
fn open_runtime_tar_locked(
    tar_path: &Path,
) -> Result<(File, RuntimePackageSnapshot), RuntimeImportError> {
    use std::os::windows::fs::OpenOptionsExt;

    const FILE_SHARE_READ: u32 = 0x00000001;
    let file = std::fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(tar_path)
        .map_err(|error| {
            RuntimeImportError::new(
                "package_lock_failed",
                format!("无法锁定运行包，文件可能正被其他程序修改：{error}"),
            )
        })?;
    let metadata = file.metadata().map_err(|error| {
        RuntimeImportError::new(
            "package_unreadable",
            format!("无法检查已锁定的运行包：{error}"),
        )
    })?;
    let modified = metadata.modified().map_err(|error| {
        RuntimeImportError::new(
            "package_unreadable",
            format!("无法读取运行包修改时间：{error}"),
        )
    })?;
    Ok((
        file,
        RuntimePackageSnapshot {
            size: metadata.len(),
            modified,
        },
    ))
}

#[cfg(windows)]
fn verify_runtime_tar_unchanged(
    file: &File,
    before: &RuntimePackageSnapshot,
) -> Result<(), RuntimeImportError> {
    let metadata = file.metadata().map_err(|_| {
        RuntimeImportError::new(
            "package_changed_during_import",
            "运行包在导入期间发生变化，已撤销本次导入。",
        )
    })?;
    let modified = metadata.modified().map_err(|_| {
        RuntimeImportError::new(
            "package_changed_during_import",
            "运行包在导入期间发生变化，已撤销本次导入。",
        )
    })?;
    if metadata.len() != before.size || modified != before.modified {
        return Err(RuntimeImportError::new(
            "package_changed_during_import",
            "运行包在导入期间发生变化，已撤销本次导入。",
        ));
    }
    Ok(())
}

fn wsl_import_args(install_dir: &Path, tar_path: &Path) -> Vec<OsString> {
    vec![
        "--import".into(),
        KOUBO_RUNTIME_DISTRO.into(),
        install_dir.as_os_str().to_owned(),
        tar_path.as_os_str().to_owned(),
        "--version".into(),
        "2".into(),
    ]
}

fn runtime_manifest_args() -> Vec<OsString> {
    vec![
        "-d".into(),
        KOUBO_RUNTIME_DISTRO.into(),
        "--exec".into(),
        "cat".into(),
        KOUBO_RUNTIME_MANIFEST_PATH.into(),
    ]
}

fn runtime_executable_probe_args() -> Vec<OsString> {
    vec![
        "-d".into(),
        KOUBO_RUNTIME_DISTRO.into(),
        "--exec".into(),
        "test".into(),
        "-x".into(),
        KOUBO_RUNTIME_EXECUTABLE_PATH.into(),
    ]
}

fn runtime_start_args() -> Vec<OsString> {
    vec![
        "-d".into(),
        KOUBO_RUNTIME_DISTRO.into(),
        "--exec".into(),
        KOUBO_RUNTIME_EXECUTABLE_PATH.into(),
        "start".into(),
    ]
}

fn runtime_stop_args() -> Vec<OsString> {
    vec![
        "-d".into(),
        KOUBO_RUNTIME_DISTRO.into(),
        "--exec".into(),
        KOUBO_RUNTIME_EXECUTABLE_PATH.into(),
        "stop".into(),
    ]
}

fn runtime_terminate_args() -> Vec<OsString> {
    vec!["--terminate".into(), KOUBO_RUNTIME_DISTRO.into()]
}

fn runtime_unregister_args() -> Vec<OsString> {
    vec!["--unregister".into(), KOUBO_RUNTIME_DISTRO.into()]
}

fn wsl_list_verbose_args() -> Vec<OsString> {
    vec!["--list".into(), "--verbose".into()]
}

fn parse_runtime_wsl_version(output: &str) -> Option<u32> {
    output.lines().find_map(|line| {
        let columns = line
            .trim()
            .trim_start_matches('*')
            .split_whitespace()
            .collect::<Vec<_>>();
        if columns
            .first()
            .is_some_and(|name| name.eq_ignore_ascii_case(KOUBO_RUNTIME_DISTRO))
        {
            columns.last()?.parse::<u32>().ok()
        } else {
            None
        }
    })
}

fn require_runtime_wsl2(version: Option<u32>) -> Result<(), RuntimeImportError> {
    match version {
        None => Err(RuntimeImportError::new(
            "runtime_not_installed",
            "KouboRuntime 尚未安装，请先导入运行包。",
        )),
        Some(2) => Ok(()),
        Some(_) => Err(RuntimeImportError::new(
            "runtime_wrong_wsl_version",
            "KouboRuntime 不是 WSL 2 发行版，已拒绝启动。请重新导入运行包。",
        )),
    }
}

const RUNTIME_LIFECYCLE_SOURCE: &str = "tauri_koubo_runtime_lifecycle";

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeLifecycleResponse {
    status: &'static str,
    source: &'static str,
    message: String,
    error: Option<RuntimeImportError>,
}

impl RuntimeLifecycleResponse {
    fn success(status: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            source: RUNTIME_LIFECYCLE_SOURCE,
            message: message.into(),
            error: None,
        }
    }

    fn failed(error: RuntimeImportError) -> Self {
        let message = error.message.clone();
        Self {
            status: "failed",
            source: RUNTIME_LIFECYCLE_SOURCE,
            message,
            error: Some(error),
        }
    }

    fn completed_with_error(
        status: &'static str,
        message: impl Into<String>,
        error: RuntimeImportError,
    ) -> Self {
        Self {
            status,
            source: RUNTIME_LIFECYCLE_SOURCE,
            message: message.into(),
            error: Some(error),
        }
    }
}

fn runtime_exit_error(
    code: &'static str,
    action: &'static str,
    exit_code: Option<i32>,
) -> RuntimeImportError {
    RuntimeImportError::new(
        code,
        format!(
            "KouboRuntime {action}失败（退出码 {}）。",
            exit_code.unwrap_or(-1)
        ),
    )
}

fn validate_runtime_manifest(bytes: &[u8]) -> Result<KouboRuntimeManifest, RuntimeImportError> {
    let manifest: KouboRuntimeManifest = serde_json::from_slice(bytes).map_err(|_| {
        RuntimeImportError::new(
            "package_invalid",
            "运行包清单无法解析，文件不是受支持的 KouboRuntime 包。",
        )
    })?;
    if manifest.schema_version != 1
        || manifest.name != KOUBO_RUNTIME_DISTRO
        || manifest.version.trim().is_empty()
        || manifest.api_url != "http://127.0.0.1:8383"
    {
        return Err(RuntimeImportError::new(
            "package_invalid",
            "运行包清单与 KouboRuntime v1 契约不匹配。",
        ));
    }
    Ok(manifest)
}

#[cfg(windows)]
fn wsl_executable_path() -> Result<PathBuf, RuntimeImportError> {
    let system_root = std::env::var_os("SystemRoot").ok_or_else(|| {
        RuntimeImportError::new(
            "wsl_not_ready",
            "Windows SystemRoot 不可用，无法定位系统 WSL。",
        )
    })?;
    let path = PathBuf::from(system_root).join("System32").join("wsl.exe");
    if !path.is_file() {
        return Err(RuntimeImportError::new(
            "wsl_not_ready",
            "未找到 Windows 系统 WSL，请先完成 WSL 安装并重启。",
        ));
    }
    Ok(path)
}

#[cfg(windows)]
fn run_wsl(
    wsl_path: &Path,
    args: &[OsString],
    timeout: Duration,
) -> Result<std::process::Output, WslCommandError> {
    use std::io::Read;
    use std::os::windows::process::CommandExt;
    use std::process::Stdio;
    use wait_timeout::ChildExt;

    const CREATE_NO_WINDOW: u32 = 0x08000000;
    fn terminate_process_tree(child: &mut std::process::Child) {
        if let Some(system_root) = std::env::var_os("SystemRoot") {
            let taskkill = PathBuf::from(system_root)
                .join("System32")
                .join("taskkill.exe");
            if taskkill.is_file() {
                let _ = std::process::Command::new(taskkill)
                    .args(["/PID", &child.id().to_string(), "/T", "/F"])
                    .creation_flags(CREATE_NO_WINDOW)
                    .stdin(Stdio::null())
                    .stdout(Stdio::null())
                    .stderr(Stdio::null())
                    .status();
            }
        }
        let _ = child.kill();
        let _ = child.wait();
    }

    let mut child = std::process::Command::new(wsl_path)
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(WslCommandError::Io)?;
    let stdout = child.stdout.take().expect("piped stdout must exist");
    let stderr = child.stderr.take().expect("piped stderr must exist");
    let stdout_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut reader = stdout;
        reader.read_to_end(&mut bytes).map(|_| bytes)
    });
    let stderr_reader = std::thread::spawn(move || {
        let mut bytes = Vec::new();
        let mut reader = stderr;
        reader.read_to_end(&mut bytes).map(|_| bytes)
    });

    let status = match child.wait_timeout(timeout) {
        Ok(Some(status)) => status,
        Ok(None) => {
            terminate_process_tree(&mut child);
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(WslCommandError::Timeout);
        }
        Err(error) => {
            terminate_process_tree(&mut child);
            let _ = stdout_reader.join();
            let _ = stderr_reader.join();
            return Err(WslCommandError::Io(error));
        }
    };
    let stdout = stdout_reader
        .join()
        .map_err(|_| WslCommandError::Io(std::io::Error::other("WSL stdout reader panicked")))?
        .map_err(WslCommandError::Io)?;
    let stderr = stderr_reader
        .join()
        .map_err(|_| WslCommandError::Io(std::io::Error::other("WSL stderr reader panicked")))?
        .map_err(WslCommandError::Io)?;
    Ok(std::process::Output {
        status,
        stdout,
        stderr,
    })
}

fn decode_wsl_text(bytes: &[u8]) -> String {
    let likely_utf16 = bytes.len() >= 2
        && bytes.len() % 2 == 0
        && bytes
            .chunks_exact(2)
            .take(64)
            .filter(|pair| pair[1] == 0)
            .count()
            > bytes.chunks_exact(2).take(64).count() / 2;
    if likely_utf16 {
        let words = bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>();
        String::from_utf16_lossy(&words).replace('\0', "")
    } else {
        String::from_utf8_lossy(bytes).replace('\0', "")
    }
}

#[cfg(windows)]
fn calculate_runtime_sha256(tar_path: &Path) -> Result<String, RuntimeImportError> {
    let certutil_path = certutil_executable_path()?;
    let output = run_wsl(
        &certutil_path,
        &certutil_hash_args(tar_path),
        RUNTIME_HASH_TIMEOUT,
    )
    .map_err(|error| match error {
        WslCommandError::Io(error) => RuntimeImportError::new(
            "package_checksum_tool_failed",
            format!("无法启动 Windows 摘要工具：{error}"),
        ),
        WslCommandError::Timeout => RuntimeImportError::new(
            "package_checksum_timeout",
            "计算运行包 SHA-256 超过 30 分钟，已终止校验。",
        ),
    })?;
    if !output.status.success() {
        return Err(RuntimeImportError::new(
            "package_checksum_tool_failed",
            format!(
                "Windows 摘要工具执行失败（退出码 {}）。",
                output.status.code().unwrap_or(-1)
            ),
        ));
    }
    parse_certutil_sha256_output(&output.stdout)
}

#[cfg(windows)]
fn runtime_is_registered(wsl_path: &Path) -> Result<bool, RuntimeImportError> {
    let output = run_wsl(
        wsl_path,
        &["--list".into(), "--quiet".into()],
        WSL_PROBE_TIMEOUT,
    )
    .map_err(|error| {
        RuntimeImportError::from_wsl_command(
            error,
            "wsl_probe_failed",
            "wsl_probe_timeout",
            |error| format!("无法读取 WSL 发行版列表：{error}"),
            "读取 WSL 发行版列表超时，请重启 WSL 后重试。",
        )
    })?;
    if !output.status.success() {
        return Err(RuntimeImportError::new(
            "wsl_not_ready",
            "WSL 尚未就绪，请完成安装或重启 Windows 后重试。",
        ));
    }
    Ok(decode_wsl_text(&output.stdout)
        .lines()
        .any(|line| line.trim().eq_ignore_ascii_case(KOUBO_RUNTIME_DISTRO)))
}

#[cfg(windows)]
fn runtime_wsl_version(wsl_path: &Path) -> Result<Option<u32>, RuntimeImportError> {
    let output =
        run_wsl(wsl_path, &wsl_list_verbose_args(), WSL_PROBE_TIMEOUT).map_err(|error| {
            RuntimeImportError::from_wsl_command(
                error,
                "wsl_probe_failed",
                "wsl_probe_timeout",
                |error| format!("无法确认 KouboRuntime 的 WSL 版本：{error}"),
                "确认 KouboRuntime 的 WSL 版本超时，请重启 WSL 后重试。",
            )
        })?;
    if !output.status.success() {
        return Err(RuntimeImportError::new(
            "wsl_not_ready",
            "无法读取 WSL 发行版版本，请确认 WSL 已完成安装。",
        ));
    }
    Ok(parse_runtime_wsl_version(&decode_wsl_text(&output.stdout)))
}

#[cfg(windows)]
fn cleanup_runtime_attempt(wsl_path: &Path, install_dir: &Path, scope: RuntimeCleanupScope) {
    let safe_to_remove = if scope.may_unregister() {
        let unregister = run_wsl(
            wsl_path,
            &["--unregister".into(), KOUBO_RUNTIME_DISTRO.into()],
            WSL_CONTROLLER_TIMEOUT,
        );
        unregister
            .as_ref()
            .map(|output| output.status.success())
            .unwrap_or(false)
            || matches!(runtime_is_registered(wsl_path), Ok(false))
    } else {
        // `--import` did not succeed, so this process never acquired ownership of a
        // distro with this name. Never unregister here: another actor may have won
        // the name between our preflight check and the failed import.
        matches!(runtime_is_registered(wsl_path), Ok(false))
    };
    if safe_to_remove && install_dir.exists() {
        let _ = std::fs::remove_dir_all(install_dir);
    }
}

#[cfg(windows)]
fn validate_installed_runtime(wsl_path: &Path) -> Result<KouboRuntimeManifest, RuntimeImportError> {
    let manifest_output =
        run_wsl(wsl_path, &runtime_manifest_args(), WSL_PROBE_TIMEOUT).map_err(|error| {
            RuntimeImportError::from_wsl_command(
                error,
                "runtime_validation_failed",
                "runtime_validation_timeout",
                |error| format!("无法读取 KouboRuntime 运行包清单：{error}"),
                "读取 KouboRuntime 运行包清单超时。",
            )
        })?;
    if !manifest_output.status.success() {
        return Err(RuntimeImportError::new(
            "package_invalid",
            "运行包缺少有效的 /etc/koubo-runtime.json。",
        ));
    }
    let text = decode_wsl_text(&manifest_output.stdout);
    let manifest = validate_runtime_manifest(text.trim_start_matches('\u{feff}').as_bytes())?;

    let executable_output = run_wsl(
        wsl_path,
        &runtime_executable_probe_args(),
        WSL_PROBE_TIMEOUT,
    )
    .map_err(|error| {
        RuntimeImportError::from_wsl_command(
            error,
            "runtime_validation_failed",
            "runtime_validation_timeout",
            |error| format!("无法检查 KouboRuntime 控制器：{error}"),
            "检查 KouboRuntime 控制器超时。",
        )
    })?;
    if !executable_output.status.success() {
        return Err(RuntimeImportError::new(
            "package_invalid",
            "运行包缺少可执行的 /opt/koubo/bin/koubo-runtime。",
        ));
    }
    Ok(manifest)
}

#[cfg(windows)]
fn import_runtime_package(
    wsl_path: PathBuf,
    app_data_dir: PathBuf,
    tar_path: PathBuf,
) -> Result<RuntimeImportResponse, RuntimeImportError> {
    let status = run_wsl(&wsl_path, &["--status".into()], WSL_PROBE_TIMEOUT).map_err(|error| {
        RuntimeImportError::from_wsl_command(
            error,
            "wsl_probe_failed",
            "wsl_probe_timeout",
            |error| format!("无法检查 WSL 状态：{error}"),
            "检查 WSL 状态超时，请重启 WSL 后重试。",
        )
    })?;
    if !status.status.success() {
        return Err(RuntimeImportError::new(
            "wsl_not_ready",
            "WSL 2 尚未就绪，请先安装 WSL 并重启 Windows。",
        ));
    }
    if runtime_is_registered(&wsl_path)? {
        return Err(RuntimeImportError::new(
            "runtime_exists",
            "KouboRuntime 已安装，请先使用环境检查确认状态。",
        ));
    }

    let tar_path = validate_runtime_tar(&tar_path)?;
    let expected_sha256 = read_runtime_expected_checksum(&tar_path)?;
    let (locked_tar, package_snapshot) = open_runtime_tar_locked(&tar_path)?;
    let actual_sha256 = calculate_runtime_sha256(&tar_path)?;
    if actual_sha256 != expected_sha256 {
        return Err(RuntimeImportError::new(
            "package_checksum_mismatch",
            "运行包 SHA-256 与 .tar.sha256 不一致，未执行导入。",
        ));
    }
    let install_dir = runtime_install_dir(&app_data_dir);
    if install_dir.exists() {
        return Err(RuntimeImportError::new(
            "runtime_directory_exists",
            "KouboRuntime 安装目录已存在。为保护已有数据，本次未覆盖。",
        ));
    }
    let runtime_root = app_data_dir.join("runtime");
    std::fs::create_dir_all(&runtime_root).map_err(|error| {
        RuntimeImportError::new(
            "runtime_directory_failed",
            format!("无法创建运行时根目录：{error}"),
        )
    })?;
    std::fs::create_dir(&install_dir).map_err(|error| {
        RuntimeImportError::new(
            "runtime_directory_failed",
            format!("无法创建 KouboRuntime 安装目录：{error}"),
        )
    })?;

    let imported = run_wsl(
        &wsl_path,
        &wsl_import_args(&install_dir, &tar_path),
        WSL_IMPORT_TIMEOUT,
    );
    match imported {
        Ok(output) if output.status.success() => {}
        Ok(output) => {
            cleanup_runtime_attempt(
                &wsl_path,
                &install_dir,
                RuntimeCleanupScope::CreatedDirectoryOnly,
            );
            return Err(RuntimeImportError::new(
                "import_failed",
                format!(
                    "KouboRuntime 导入失败（退出码 {}）。",
                    output.status.code().unwrap_or(-1)
                ),
            ));
        }
        Err(error) => {
            cleanup_runtime_attempt(
                &wsl_path,
                &install_dir,
                RuntimeCleanupScope::CreatedDirectoryOnly,
            );
            return Err(RuntimeImportError::from_wsl_command(
                error,
                "import_failed",
                "import_timeout",
                |error| format!("无法启动 KouboRuntime 导入：{error}"),
                "KouboRuntime 导入超过 30 分钟，已终止本次导入。",
            ));
        }
    };

    let manifest = validate_installed_runtime(&wsl_path).map_err(|error| {
        cleanup_runtime_attempt(&wsl_path, &install_dir, RuntimeCleanupScope::ImportedDistro);
        RuntimeImportError::new(
            error.code,
            format!("{} 已撤销本次导入。", error.message.trim_end_matches('。')),
        )
    })?;

    if let Err(error) = verify_runtime_tar_unchanged(&locked_tar, &package_snapshot) {
        cleanup_runtime_attempt(&wsl_path, &install_dir, RuntimeCleanupScope::ImportedDistro);
        return Err(error);
    }

    Ok(RuntimeImportResponse {
        status: "ok",
        source: "tauri_koubo_runtime_importer",
        distro_name: KOUBO_RUNTIME_DISTRO,
        version: Some(manifest.version),
        sha256: Some(actual_sha256),
        message: "KouboRuntime 已安全导入，可以重新检查数字人环境。".to_string(),
    })
}

#[tauri::command]
async fn import_koubo_runtime(
    app: tauri::AppHandle,
) -> Result<RuntimeImportResponse, RuntimeImportError> {
    let _guard = RuntimeOperationGuard::acquire(
        "import_in_progress",
        "KouboRuntime 正在执行其他操作，请等待当前任务完成。",
    )?;

    #[cfg(not(windows))]
    {
        let _ = app;
        return Err(RuntimeImportError::new(
            "platform_unsupported",
            "仅 Windows 桌面端支持导入 KouboRuntime。",
        ));
    }

    #[cfg(windows)]
    {
        use tauri::Manager;
        use tauri_plugin_dialog::DialogExt;

        let selected = app
            .dialog()
            .file()
            .set_title("选择 KouboRuntime WSL 运行包")
            .add_filter("KouboRuntime WSL 包", &["tar"])
            .blocking_pick_file();
        let Some(selected) = selected else {
            return Ok(RuntimeImportResponse {
                status: "cancelled",
                source: "tauri_koubo_runtime_importer",
                distro_name: KOUBO_RUNTIME_DISTRO,
                version: None,
                sha256: None,
                message: "已取消选择运行包。".to_string(),
            });
        };
        let tar_path = selected.into_path().map_err(|_| {
            RuntimeImportError::new("package_unreadable", "所选位置不是可读取的本地文件。")
        })?;
        let app_data_dir = app.path().app_local_data_dir().map_err(|error| {
            RuntimeImportError::new(
                "app_data_unavailable",
                format!("无法定位本地应用数据目录：{error}"),
            )
        })?;
        let wsl_path = wsl_executable_path()?;

        tauri::async_runtime::spawn_blocking(move || {
            import_runtime_package(wsl_path, app_data_dir, tar_path)
        })
        .await
        .map_err(|error| {
            RuntimeImportError::new(
                "import_task_failed",
                format!("KouboRuntime 后台导入任务异常结束：{error}"),
            )
        })?
    }
}

#[cfg(windows)]
fn start_runtime(wsl_path: PathBuf) -> RuntimeLifecycleResponse {
    let version = match runtime_wsl_version(&wsl_path) {
        Ok(version) => version,
        Err(error) => return RuntimeLifecycleResponse::failed(error),
    };
    if let Err(error) = require_runtime_wsl2(version) {
        return RuntimeLifecycleResponse::failed(error);
    }
    if let Err(error) = validate_installed_runtime(&wsl_path) {
        return RuntimeLifecycleResponse::failed(error);
    }

    match run_wsl(&wsl_path, &runtime_start_args(), WSL_CONTROLLER_TIMEOUT) {
        Ok(output) if output.status.success() => RuntimeLifecycleResponse::success(
            "running",
            "KouboRuntime 已启动，数字人服务正在后台运行。",
        ),
        Ok(output) => RuntimeLifecycleResponse::failed(runtime_exit_error(
            "runtime_start_failed",
            "启动",
            output.status.code(),
        )),
        Err(error) => RuntimeLifecycleResponse::failed(RuntimeImportError::from_wsl_command(
            error,
            "runtime_start_failed",
            "runtime_start_timeout",
            |error| format!("无法启动 KouboRuntime：{error}"),
            "KouboRuntime 控制器启动超过 120 秒，已终止等待。",
        )),
    }
}

#[cfg(windows)]
fn stop_runtime(wsl_path: PathBuf) -> RuntimeLifecycleResponse {
    let registered = match runtime_is_registered(&wsl_path) {
        Ok(registered) => registered,
        Err(error) => return RuntimeLifecycleResponse::failed(error),
    };
    if !registered {
        return RuntimeLifecycleResponse::failed(RuntimeImportError::new(
            "runtime_not_installed",
            "KouboRuntime 尚未安装，无需停止。",
        ));
    }

    let graceful_error = match run_wsl(&wsl_path, &runtime_stop_args(), WSL_CONTROLLER_TIMEOUT) {
        Ok(output) if output.status.success() => None,
        Ok(output) => Some(runtime_exit_error(
            "runtime_stop_failed",
            "停止服务",
            output.status.code(),
        )),
        Err(error) => Some(RuntimeImportError::from_wsl_command(
            error,
            "runtime_stop_failed",
            "runtime_stop_timeout",
            |error| format!("无法执行 KouboRuntime 停止命令：{error}"),
            "KouboRuntime 控制器停止超过 120 秒，已终止等待。",
        )),
    };

    match run_wsl(&wsl_path, &runtime_terminate_args(), WSL_CONTROLLER_TIMEOUT) {
        Ok(output) if output.status.success() => {
            if let Some(error) = graceful_error {
                RuntimeLifecycleResponse::completed_with_error(
                    "stopped",
                    "KouboRuntime 服务未能正常退出，但 WSL 运行实例已终止。",
                    error,
                )
            } else {
                RuntimeLifecycleResponse::success(
                    "stopped",
                    "KouboRuntime 已停止，后台 WSL 运行实例已释放。",
                )
            }
        }
        Ok(output) => RuntimeLifecycleResponse::failed(runtime_exit_error(
            "runtime_terminate_failed",
            "终止 WSL 运行实例",
            output.status.code(),
        )),
        Err(error) => RuntimeLifecycleResponse::failed(RuntimeImportError::from_wsl_command(
            error,
            "runtime_terminate_failed",
            "runtime_terminate_timeout",
            |error| format!("无法终止 KouboRuntime WSL 运行实例：{error}"),
            "终止 KouboRuntime WSL 运行实例超过 120 秒，已终止等待。",
        )),
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuntimeInstallCleanup {
    NotPresent,
    RemovedEmptyDirectory,
    Quarantined,
}

fn runtime_path_is_reparse_or_symlink(metadata: &std::fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x0400;
        return metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0;
    }
    #[cfg(not(windows))]
    false
}

fn quarantine_runtime_install_path(
    install_dir: &Path,
) -> Result<RuntimeInstallCleanup, RuntimeImportError> {
    let metadata = match std::fs::symlink_metadata(install_dir) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(RuntimeInstallCleanup::NotPresent)
        }
        Err(error) => {
            return Err(RuntimeImportError::new(
                "runtime_cleanup_probe_failed",
                format!("无法检查 KouboRuntime 安装目录：{error}"),
            ))
        }
    };

    let parent = install_dir.parent().ok_or_else(|| {
        RuntimeImportError::new(
            "runtime_cleanup_failed",
            "KouboRuntime 安装目录没有安全的父目录，已停止清理。",
        )
    })?;
    let parent_metadata = std::fs::symlink_metadata(parent).map_err(|error| {
        RuntimeImportError::new(
            "runtime_cleanup_probe_failed",
            format!("无法检查 KouboRuntime 运行时根目录：{error}"),
        )
    })?;
    if !parent_metadata.is_dir() || runtime_path_is_reparse_or_symlink(&parent_metadata) {
        return Err(RuntimeImportError::new(
            "runtime_cleanup_unsafe_path",
            "KouboRuntime 运行时根目录不是安全的普通目录，已停止清理。",
        ));
    }

    if metadata.is_dir() && !runtime_path_is_reparse_or_symlink(&metadata) {
        let mut entries = std::fs::read_dir(install_dir).map_err(|error| {
            RuntimeImportError::new(
                "runtime_cleanup_probe_failed",
                format!("无法检查 KouboRuntime 安装目录内容：{error}"),
            )
        })?;
        if entries.next().is_none() {
            std::fs::remove_dir(install_dir).map_err(|error| {
                RuntimeImportError::new(
                    "runtime_cleanup_failed",
                    format!("无法移除空的 KouboRuntime 安装目录：{error}"),
                )
            })?;
            return Ok(RuntimeInstallCleanup::RemovedEmptyDirectory);
        }
    }

    let quarantine = parent.join(format!(
        "{KOUBO_RUNTIME_DISTRO}.removed-{}",
        uuid::Uuid::new_v4()
    ));
    std::fs::rename(install_dir, &quarantine).map_err(|error| {
        RuntimeImportError::new(
            "runtime_cleanup_failed",
            format!("无法隔离 KouboRuntime 旧安装目录：{error}"),
        )
    })?;
    Ok(RuntimeInstallCleanup::Quarantined)
}

#[cfg(windows)]
fn uninstall_runtime(wsl_path: PathBuf, install_dir: PathBuf) -> RuntimeLifecycleResponse {
    let registered = match runtime_is_registered(&wsl_path) {
        Ok(registered) => registered,
        Err(error) => return RuntimeLifecycleResponse::failed(error),
    };
    let has_install_path = match std::fs::symlink_metadata(&install_dir) {
        Ok(_) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => {
            return RuntimeLifecycleResponse::failed(RuntimeImportError::new(
                "runtime_cleanup_probe_failed",
                format!("无法检查 KouboRuntime 安装目录：{error}"),
            ))
        }
    };
    if !registered && !has_install_path {
        return RuntimeLifecycleResponse::success("absent", "KouboRuntime 未安装，无需移除。");
    }

    // The caller has already shown the native confirmation. Probe again here so
    // no stale UI snapshot is trusted across that user decision.
    if let Err(error) = runtime_is_registered(&wsl_path) {
        return RuntimeLifecycleResponse::failed(error);
    }
    let _ = run_wsl(&wsl_path, &runtime_terminate_args(), WSL_CONTROLLER_TIMEOUT);
    let unregister = run_wsl(
        &wsl_path,
        &runtime_unregister_args(),
        WSL_CONTROLLER_TIMEOUT,
    );
    let registered_after = match runtime_is_registered(&wsl_path) {
        Ok(registered) => registered,
        Err(error) => return RuntimeLifecycleResponse::failed(error),
    };
    if registered_after {
        return match unregister {
            Ok(output) => RuntimeLifecycleResponse::failed(runtime_exit_error(
                "runtime_unregister_failed",
                "注销 WSL 发行版",
                output.status.code(),
            )),
            Err(error) => RuntimeLifecycleResponse::failed(RuntimeImportError::from_wsl_command(
                error,
                "runtime_unregister_failed",
                "runtime_unregister_timeout",
                |error| format!("无法注销 KouboRuntime WSL 发行版：{error}"),
                "注销 KouboRuntime WSL 发行版超过 120 秒，已终止等待。",
            )),
        };
    }

    match quarantine_runtime_install_path(&install_dir) {
        Ok(RuntimeInstallCleanup::Quarantined) => RuntimeLifecycleResponse::success(
            "absent",
            "KouboRuntime 已移除；旧运行目录已安全隔离，现在可以重新导入。",
        ),
        Ok(_) => RuntimeLifecycleResponse::success(
            "absent",
            "KouboRuntime 已移除，现在可以重新导入运行包。",
        ),
        Err(error) => RuntimeLifecycleResponse::failed(error),
    }
}

#[tauri::command]
async fn start_koubo_runtime() -> RuntimeLifecycleResponse {
    let _guard = match RuntimeOperationGuard::acquire(
        "runtime_busy",
        "KouboRuntime 正在执行其他操作，请稍后再试。",
    ) {
        Ok(guard) => guard,
        Err(error) => return RuntimeLifecycleResponse::failed(error),
    };

    #[cfg(not(windows))]
    {
        RuntimeLifecycleResponse::failed(RuntimeImportError::new(
            "platform_unsupported",
            "仅 Windows 桌面端支持启动 KouboRuntime。",
        ))
    }

    #[cfg(windows)]
    {
        let wsl_path = match wsl_executable_path() {
            Ok(path) => path,
            Err(error) => return RuntimeLifecycleResponse::failed(error),
        };
        match tauri::async_runtime::spawn_blocking(move || start_runtime(wsl_path)).await {
            Ok(response) => response,
            Err(error) => RuntimeLifecycleResponse::failed(RuntimeImportError::new(
                "runtime_task_failed",
                format!("KouboRuntime 启动任务异常结束：{error}"),
            )),
        }
    }
}

#[tauri::command]
async fn stop_koubo_runtime() -> RuntimeLifecycleResponse {
    let _guard = match RuntimeOperationGuard::acquire(
        "runtime_busy",
        "KouboRuntime 正在执行其他操作，请稍后再试。",
    ) {
        Ok(guard) => guard,
        Err(error) => return RuntimeLifecycleResponse::failed(error),
    };

    #[cfg(not(windows))]
    {
        RuntimeLifecycleResponse::failed(RuntimeImportError::new(
            "platform_unsupported",
            "仅 Windows 桌面端支持停止 KouboRuntime。",
        ))
    }

    #[cfg(windows)]
    {
        let wsl_path = match wsl_executable_path() {
            Ok(path) => path,
            Err(error) => return RuntimeLifecycleResponse::failed(error),
        };
        match tauri::async_runtime::spawn_blocking(move || stop_runtime(wsl_path)).await {
            Ok(response) => response,
            Err(error) => RuntimeLifecycleResponse::failed(RuntimeImportError::new(
                "runtime_task_failed",
                format!("KouboRuntime 停止任务异常结束：{error}"),
            )),
        }
    }
}

#[tauri::command]
async fn uninstall_koubo_runtime(app: tauri::AppHandle) -> RuntimeLifecycleResponse {
    let _guard = match RuntimeOperationGuard::acquire(
        "runtime_busy",
        "KouboRuntime 正在执行其他操作，请稍后再试。",
    ) {
        Ok(guard) => guard,
        Err(error) => return RuntimeLifecycleResponse::failed(error),
    };

    #[cfg(not(windows))]
    {
        let _ = app;
        RuntimeLifecycleResponse::failed(RuntimeImportError::new(
            "platform_unsupported",
            "仅 Windows 桌面端支持移除 KouboRuntime。",
        ))
    }

    #[cfg(windows)]
    {
        use tauri::Manager;
        use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};

        let app_data_dir = match app.path().app_local_data_dir() {
            Ok(path) => path,
            Err(error) => {
                return RuntimeLifecycleResponse::failed(RuntimeImportError::new(
                    "app_data_unavailable",
                    format!("无法定位本地应用数据目录：{error}"),
                ))
            }
        };
        let install_dir = runtime_install_dir(&app_data_dir);
        let wsl_path = match wsl_executable_path() {
            Ok(path) => path,
            Err(error) => return RuntimeLifecycleResponse::failed(error),
        };

        match tauri::async_runtime::spawn_blocking(move || {
            let registered = runtime_is_registered(&wsl_path)?;
            let has_install_path = match std::fs::symlink_metadata(&install_dir) {
                Ok(_) => true,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
                Err(error) => {
                    return Err(RuntimeImportError::new(
                        "runtime_cleanup_probe_failed",
                        format!("无法检查 KouboRuntime 安装目录：{error}"),
                    ))
                }
            };
            if !registered && !has_install_path {
                return Ok(RuntimeLifecycleResponse::success(
                    "absent",
                    "KouboRuntime 未安装，无需移除。",
                ));
            }

            let confirmed = app
                .dialog()
                .message(
                    "这会移除 KouboRuntime WSL 运行环境及其内部模型数据。\n\n不会删除创作项目、素材，也不会影响其他 WSL 发行版。",
                )
                .title("移除 KouboRuntime？")
                .kind(MessageDialogKind::Warning)
                .buttons(MessageDialogButtons::OkCancelCustom(
                    "移除运行环境".to_string(),
                    "取消".to_string(),
                ))
                .blocking_show();
            if !confirmed {
                return Ok(RuntimeLifecycleResponse::success(
                    "cancelled",
                    "已取消移除 KouboRuntime。",
                ));
            }
            Ok(uninstall_runtime(wsl_path, install_dir))
        })
        .await
        {
            Ok(Ok(response)) => response,
            Ok(Err(error)) => RuntimeLifecycleResponse::failed(error),
            Err(error) => RuntimeLifecycleResponse::failed(RuntimeImportError::new(
                "runtime_task_failed",
                format!("KouboRuntime 移除任务异常结束：{error}"),
            )),
        }
    }
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct WslInstallResponse {
    status: &'static str,
    source: &'static str,
    restart_required: bool,
    message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<WslInstallError>,
}

#[derive(Debug, serde::Serialize)]
struct WslInstallError {
    code: &'static str,
    message: String,
}

static WSL_INSTALL_RUNNING: std::sync::atomic::AtomicBool =
    std::sync::atomic::AtomicBool::new(false);

struct WslInstallGuard;

impl WslInstallGuard {
    fn try_acquire() -> Option<Self> {
        WSL_INSTALL_RUNNING
            .compare_exchange(
                false,
                true,
                std::sync::atomic::Ordering::AcqRel,
                std::sync::atomic::Ordering::Acquire,
            )
            .ok()
            .map(|_| Self)
    }
}

impl Drop for WslInstallGuard {
    fn drop(&mut self) {
        WSL_INSTALL_RUNNING.store(false, std::sync::atomic::Ordering::Release);
    }
}

impl WslInstallResponse {
    fn success(restart_required: bool, message: impl Into<String>) -> Self {
        Self {
            status: "ok",
            source: "tauri_wsl_installer",
            restart_required,
            message: message.into(),
            error: None,
        }
    }

    fn failed(code: &'static str, message: impl Into<String>) -> Self {
        let message = message.into();
        Self {
            status: "error",
            source: "tauri_wsl_installer",
            restart_required: false,
            error: Some(WslInstallError {
                code,
                message: message.clone(),
            }),
            message,
        }
    }
}

fn wsl_install_powershell_script() -> &'static str {
    "$ErrorActionPreference = 'Stop'; try { $wslPath = Join-Path $env:SystemRoot 'System32\\wsl.exe'; if (-not (Test-Path -LiteralPath $wslPath -PathType Leaf)) { exit 2 }; $process = Start-Process -FilePath $wslPath -ArgumentList @('--install','--no-distribution') -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $process.ExitCode } catch { if ($_.Exception.NativeErrorCode -eq 1223 -or $_.Exception.InnerException.NativeErrorCode -eq 1223) { exit 1223 }; exit 1 }"
}

fn map_wsl_install_exit(exit_code: Option<i32>) -> WslInstallResponse {
    match exit_code {
        Some(0) => WslInstallResponse::success(false, "WSL 安装命令已完成，请重新检查环境。"),
        // HRESULT_FROM_WIN32(ERROR_SUCCESS_REBOOT_REQUIRED), observed by
        // Rust's ExitStatus as a signed Windows process exit code.
        Some(1641) | Some(3010) | Some(-2147021886) => {
            WslInstallResponse::success(true, "WSL 安装已提交，需要重启 Windows 后继续。")
        }
        Some(1223) => WslInstallResponse::failed(
            "wsl_install_uac_cancelled",
            "已取消管理员授权，WSL 未安装；可再次点击安装。",
        ),
        Some(exit_code) => WslInstallResponse::failed(
            "wsl_install_failed",
            format!("WSL 安装未完成（退出码 {exit_code}）。"),
        ),
        None => WslInstallResponse::failed(
            "wsl_installer_terminated",
            "WSL 安装程序异常结束，未返回退出码。",
        ),
    }
}

#[cfg(windows)]
fn install_wsl_blocking() -> WslInstallResponse {
    use std::os::windows::process::CommandExt;
    use std::process::Command;

    const CREATE_NO_WINDOW: u32 = 0x08000000;
    let Some(system_root) = std::env::var_os("SystemRoot") else {
        return WslInstallResponse::failed(
            "system_root_unavailable",
            "Windows SystemRoot 不可用，无法定位系统安装程序。",
        );
    };
    let powershell_path = PathBuf::from(system_root)
        .join("System32")
        .join("WindowsPowerShell")
        .join("v1.0")
        .join("powershell.exe");
    if !powershell_path.is_file() {
        return WslInstallResponse::failed(
            "wsl_installer_unavailable",
            "未找到 Windows 系统 PowerShell，无法启动 WSL 安装。",
        );
    }

    match Command::new(powershell_path)
        .args([
            "-NoProfile",
            "-NonInteractive",
            "-WindowStyle",
            "Hidden",
            "-Command",
            wsl_install_powershell_script(),
        ])
        .creation_flags(CREATE_NO_WINDOW)
        .status()
    {
        Ok(status) => map_wsl_install_exit(status.code()),
        Err(error) => WslInstallResponse::failed(
            "wsl_installer_launch_failed",
            format!("无法启动 WSL 安装程序：{error}"),
        ),
    }
}

#[tauri::command]
async fn install_wsl() -> WslInstallResponse {
    #[cfg(not(windows))]
    {
        return WslInstallResponse::failed(
            "platform_unsupported",
            "仅 Windows 桌面端支持安装 WSL。",
        );
    }

    #[cfg(windows)]
    {
        let Some(guard) = WslInstallGuard::try_acquire() else {
            return WslInstallResponse::failed(
                "wsl_install_in_progress",
                "WSL 安装正在进行，请等待当前安装完成。",
            );
        };
        match tauri::async_runtime::spawn_blocking(move || {
            let _guard = guard;
            install_wsl_blocking()
        })
        .await
        {
            Ok(response) => response,
            Err(error) => WslInstallResponse::failed(
                "wsl_install_task_failed",
                format!("WSL 安装任务异常结束：{error}"),
            ),
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    use std::fs::{File, OpenOptions};
    use std::io::{Read, Write};
    use std::net::{SocketAddr, TcpStream};
    use std::path::PathBuf;
    use std::process::{Child, Command, Stdio};
    use std::sync::Mutex;
    use tauri::Manager;

    struct BackendSidecar {
        child: Mutex<Option<Child>>,
        backend_port: String,
        desktop_api_token: String,
    }

    impl BackendSidecar {
        fn stop(&self) {
            graceful_shutdown_backend(&self.backend_port, &self.desktop_api_token);
            if let Ok(mut child) = self.child.lock() {
                if let Some(mut child) = child.take() {
                    let _ = child.kill();
                    let _ = child.wait();
                    log_sidecar("backend_stopped=true");
                }
            }
        }
    }

    fn graceful_shutdown_backend(port: &str, token: &str) {
        let Ok(port_number) = port.parse::<u16>() else {
            return;
        };
        let address = SocketAddr::from(([127, 0, 0, 1], port_number));
        let Ok(mut stream) =
            TcpStream::connect_timeout(&address, std::time::Duration::from_millis(600))
        else {
            return;
        };
        let _ = stream.set_read_timeout(Some(std::time::Duration::from_millis(1400)));
        let _ = stream.set_write_timeout(Some(std::time::Duration::from_millis(600)));
        let request = format!(
            "POST /api/desktop/shutdown HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nOrigin: http://127.0.0.1:{port}\r\nSec-Fetch-Site: same-origin\r\nX-Koubo-Desktop-Token: {token}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
        );
        if stream.write_all(request.as_bytes()).is_ok() {
            let mut response = [0_u8; 64];
            if let Ok(read) = stream.read(&mut response) {
                if read > 0 && String::from_utf8_lossy(&response[..read]).contains(" 200 ") {
                    log_sidecar("backend_graceful_shutdown=true");
                }
            }
        }
    }

    impl Drop for BackendSidecar {
        fn drop(&mut self) {
            self.stop();
        }
    }

    fn log_sidecar(message: &str) {
        let path = std::env::temp_dir().join("koubo-agent-sidecar.log");
        if let Ok(mut file) = OpenOptions::new().create(true).append(true).open(path) {
            let _ = writeln!(file, "{message}");
        }
    }

    fn find_backend_dir(resource_dir: &PathBuf) -> PathBuf {
        let direct = resource_dir.join("koubo-backend");
        let nested = resource_dir.join("resources").join("koubo-backend");
        let candidates = [direct, nested];

        for candidate in candidates.iter() {
            let node_path = candidate.join(if cfg!(windows) { "node.exe" } else { "node" });
            let server_path = candidate.join("server.js");
            log_sidecar(&format!(
                "candidate={} node_exists={} server_exists={}",
                candidate.display(),
                node_path.exists(),
                server_path.exists()
            ));
            if node_path.exists() && server_path.exists() {
                return candidate.clone();
            }
        }

        candidates[0].clone()
    }

    #[cfg(windows)]
    fn path_for_child_process(path: &PathBuf) -> PathBuf {
        let value = path.to_string_lossy();
        if let Some(stripped) = value.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{}", stripped));
        }
        if let Some(stripped) = value.strip_prefix(r"\\?\") {
            return PathBuf::from(stripped);
        }
        path.clone()
    }

    #[cfg(not(windows))]
    fn path_for_child_process(path: &PathBuf) -> PathBuf {
        path.clone()
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            install_wsl,
            import_koubo_runtime,
            start_koubo_runtime,
            stop_koubo_runtime,
            uninstall_koubo_runtime
        ])
        .setup(|app| {
            let resource_dir = app.path().resource_dir()?;
            let backend_dir = find_backend_dir(&resource_dir);
            let node_path = backend_dir.join(if cfg!(windows) { "node.exe" } else { "node" });
            let server_path = backend_dir.join("server.js");
            let child_backend_dir = path_for_child_process(&backend_dir);
            let child_node_path = path_for_child_process(&node_path);
            let child_server_path = path_for_child_process(&server_path);
            let app_data_root = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data_root)?;
            let workspaces_root = app_data_root.join("workspaces");
            let browser_profile_root = app_data_root.join("browser-profile");
            std::fs::create_dir_all(&workspaces_root)?;
            log_sidecar(&format!("resource_dir={}", resource_dir.display()));
            log_sidecar(&format!("app_data_root={}", app_data_root.display()));
            log_sidecar(&format!("backend_dir={}", backend_dir.display()));
            log_sidecar(&format!(
                "node_exists={} path={}",
                node_path.exists(),
                node_path.display()
            ));
            log_sidecar(&format!(
                "server_exists={} path={}",
                server_path.exists(),
                server_path.display()
            ));
            log_sidecar(&format!(
                "child_backend_dir={}",
                child_backend_dir.display()
            ));
            log_sidecar(&format!(
                "child_server_path={}",
                child_server_path.display()
            ));
            let backend_port = std::env::var("KOUBO_BACKEND_PORT")
                .or_else(|_| std::env::var("PORT"))
                .unwrap_or_else(|_| "3100".to_string());
            let desktop_api_token = uuid::Uuid::new_v4().simple().to_string();
            log_sidecar(&format!("backend_port={backend_port}"));

            let child = if node_path.exists() && server_path.exists() {
                let stdout =
                    File::create(std::env::temp_dir().join("koubo-agent-backend.stdout.log"))?;
                let stderr =
                    File::create(std::env::temp_dir().join("koubo-agent-backend.stderr.log"))?;
                let child = Command::new(child_node_path)
                    .arg(child_server_path)
                    .current_dir(&child_backend_dir)
                    .env("HOSTNAME", "127.0.0.1")
                    .env("PORT", &backend_port)
                    .env("KOUBO_BACKEND_PORT", &backend_port)
                    .env("DESKTOP_BACKEND_MODE", "sidecar")
                    .env("KOUBO_DESKTOP_API_TOKEN", &desktop_api_token)
                    .env("KOUBO_APP_DATA_ROOT", &app_data_root)
                    .env("KOUBO_WORKSPACES_ROOT", &workspaces_root)
                    .env("KOUBO_BROWSER_PROFILE_ROOT", &browser_profile_root)
                    .stdin(Stdio::null())
                    .stdout(Stdio::from(stdout))
                    .stderr(Stdio::from(stderr))
                    .spawn()?;
                log_sidecar("backend_spawned=true");
                Some(child)
            } else {
                log_sidecar("backend_spawned=false");
                None
            };

            app.manage(BackendSidecar {
                child: Mutex::new(child),
                backend_port,
                desktop_api_token,
            });
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if matches!(
                event,
                tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit
            ) {
                app_handle.state::<BackendSidecar>().stop();
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{
        certutil_hash_args, decode_wsl_text, map_wsl_install_exit, parse_certutil_sha256_output,
        parse_runtime_checksum_file, parse_runtime_wsl_version, require_runtime_wsl2,
        runtime_checksum_path, runtime_executable_probe_args, runtime_install_dir,
        runtime_manifest_args, runtime_start_args, runtime_stop_args, runtime_terminate_args,
        runtime_unregister_args, validate_runtime_manifest, validate_runtime_tar, wsl_import_args,
        wsl_install_powershell_script, wsl_list_verbose_args, RuntimeCleanupScope,
        RuntimeImportError, RuntimeInstallCleanup, RuntimeLifecycleResponse, RuntimeOperationGuard,
        WslCommandError, WslInstallGuard, WslInstallResponse, KOUBO_RUNTIME_DISTRO,
        MIN_RUNTIME_TAR_BYTES, RUNTIME_HASH_TIMEOUT, RUNTIME_LIFECYCLE_SOURCE,
        WSL_CONTROLLER_TIMEOUT, WSL_IMPORT_TIMEOUT, WSL_PROBE_TIMEOUT,
    };
    use std::ffi::OsString;
    use std::fs::OpenOptions;

    #[test]
    fn wsl_install_command_is_fixed_and_does_not_install_a_store_distribution() {
        let script = wsl_install_powershell_script();
        assert!(script.contains("$env:SystemRoot"));
        assert!(script.contains("System32\\wsl.exe"));
        assert!(script.contains("'--install','--no-distribution'"));
        assert!(script.contains("-Verb RunAs"));
        assert!(script.contains("$ErrorActionPreference = 'Stop'"));
        assert!(script.contains("NativeErrorCode -eq 1223"));
        assert!(script.contains("exit 1223"));
        assert!(script.contains("exit 1"));
        assert!(!script.contains("Ubuntu"));
    }

    #[test]
    fn wsl_install_exit_codes_have_stable_structured_results() {
        let completed = serde_json::to_value(map_wsl_install_exit(Some(0))).unwrap();
        assert_eq!(completed["status"], "ok");
        assert_eq!(completed["restartRequired"], false);
        assert!(completed.get("error").is_none());

        for exit_code in [1641, 3010, -2147021886] {
            let needs_restart =
                serde_json::to_value(map_wsl_install_exit(Some(exit_code))).unwrap();
            assert_eq!(needs_restart["status"], "ok");
            assert_eq!(needs_restart["restartRequired"], true);
            assert!(needs_restart.get("error").is_none());
        }

        let cancelled = serde_json::to_value(map_wsl_install_exit(Some(1223))).unwrap();
        assert_eq!(cancelled["status"], "error");
        assert_eq!(cancelled["restartRequired"], false);
        assert_eq!(cancelled["error"]["code"], "wsl_install_uac_cancelled");

        let failed = serde_json::to_value(map_wsl_install_exit(Some(2))).unwrap();
        assert_eq!(failed["status"], "error");
        assert_eq!(failed["error"]["code"], "wsl_install_failed");

        let terminated = serde_json::to_value(map_wsl_install_exit(None)).unwrap();
        assert_eq!(terminated["error"]["code"], "wsl_installer_terminated");
    }

    #[test]
    fn wsl_install_launch_failures_preserve_the_client_compatible_error_shape() {
        let response =
            WslInstallResponse::failed("wsl_installer_launch_failed", "无法启动 WSL 安装程序。");
        let json = serde_json::to_value(response).unwrap();
        assert_eq!(json["status"], "error");
        assert_eq!(json["source"], "tauri_wsl_installer");
        assert_eq!(json["restartRequired"], false);
        assert_eq!(json["message"], "无法启动 WSL 安装程序。");
        assert_eq!(json["error"]["code"], "wsl_installer_launch_failed");
        assert_eq!(json["error"]["message"], "无法启动 WSL 安装程序。");
    }

    #[test]
    fn wsl_install_has_a_native_single_flight_guard() {
        let first = WslInstallGuard::try_acquire().expect("first install should acquire guard");
        assert!(WslInstallGuard::try_acquire().is_none());
        drop(first);
        assert!(WslInstallGuard::try_acquire().is_some());
    }

    #[test]
    fn runtime_import_uses_fixed_distro_and_direct_wsl_arguments() {
        let install_dir = std::path::Path::new(r"C:\AppData\runtime\KouboRuntime");
        let tar_path = std::path::Path::new(r"D:\packages\koubo-runtime.tar");
        assert_eq!(
            wsl_import_args(install_dir, tar_path),
            vec![
                OsString::from("--import"),
                OsString::from(KOUBO_RUNTIME_DISTRO),
                install_dir.as_os_str().to_owned(),
                tar_path.as_os_str().to_owned(),
                OsString::from("--version"),
                OsString::from("2"),
            ]
        );
        assert_eq!(
            certutil_hash_args(tar_path),
            vec![
                OsString::from("-hashfile"),
                tar_path.as_os_str().to_owned(),
                OsString::from("SHA256"),
            ]
        );
        assert_eq!(
            runtime_checksum_path(tar_path),
            std::path::PathBuf::from(r"D:\packages\koubo-runtime.tar.sha256")
        );
        let flattened = wsl_import_args(install_dir, tar_path)
            .into_iter()
            .map(|value| value.to_string_lossy().into_owned())
            .collect::<Vec<_>>()
            .join(" ")
            .to_ascii_lowercase();
        for shell in ["powershell", "cmd.exe", "bash", "sh -c"] {
            assert!(!flattened.contains(shell));
        }
        assert_eq!(
            runtime_install_dir(std::path::Path::new(r"C:\AppData")),
            std::path::Path::new(r"C:\AppData")
                .join("runtime")
                .join(KOUBO_RUNTIME_DISTRO)
        );
    }

    #[test]
    fn failed_import_cleanup_never_owns_or_unregisters_a_distro() {
        assert!(!RuntimeCleanupScope::CreatedDirectoryOnly.may_unregister());
        assert!(RuntimeCleanupScope::ImportedDistro.may_unregister());
    }

    #[test]
    fn runtime_start_preflight_requires_the_fixed_distro_to_be_wsl2() {
        let output = "  NAME             STATE           VERSION\r\n\
                      * Ubuntu           Running         2\r\n\
                        KouboRuntime      Stopped         2\r\n";
        assert_eq!(wsl_list_verbose_args(), vec!["--list", "--verbose"]);
        assert_eq!(parse_runtime_wsl_version(output), Some(2));
        assert!(require_runtime_wsl2(Some(2)).is_ok());
        assert_eq!(
            require_runtime_wsl2(Some(1)).unwrap_err().code,
            "runtime_wrong_wsl_version"
        );
        assert_eq!(
            require_runtime_wsl2(None).unwrap_err().code,
            "runtime_not_installed"
        );
        assert_eq!(parse_runtime_wsl_version("Ubuntu Running 2\r\n"), None);
    }

    #[test]
    fn wsl_operations_have_bounded_timeouts_and_stable_timeout_errors() {
        assert_eq!(
            RUNTIME_HASH_TIMEOUT,
            std::time::Duration::from_secs(30 * 60)
        );
        assert_eq!(WSL_PROBE_TIMEOUT, std::time::Duration::from_secs(30));
        assert_eq!(WSL_IMPORT_TIMEOUT, std::time::Duration::from_secs(30 * 60));
        assert_eq!(WSL_CONTROLLER_TIMEOUT, std::time::Duration::from_secs(120));
        let error = RuntimeImportError::from_wsl_command(
            WslCommandError::Timeout,
            "runtime_start_failed",
            "runtime_start_timeout",
            |_| "unreachable".to_string(),
            "启动超时。",
        );
        assert_eq!(error.code, "runtime_start_timeout");
        assert_eq!(error.message, "启动超时。");
    }

    #[test]
    fn runtime_checksum_file_accepts_only_one_lowercase_digest_with_final_newline() {
        let digest = "0123456789abcdef".repeat(4);
        assert_eq!(
            parse_runtime_checksum_file(format!("{digest}\n").as_bytes()).unwrap(),
            digest
        );
        assert_eq!(
            parse_runtime_checksum_file(format!("{digest}\r\n").as_bytes()).unwrap(),
            digest
        );

        for invalid in [
            digest.to_ascii_uppercase(),
            digest.clone(),
            format!(" {digest}\n"),
            format!("{digest}  KouboRuntime.tar\n"),
            format!("{digest}\n\n"),
            format!("\u{feff}{digest}\n"),
        ] {
            assert_eq!(
                parse_runtime_checksum_file(invalid.as_bytes())
                    .unwrap_err()
                    .code,
                "package_checksum_invalid"
            );
        }
    }

    #[test]
    fn certutil_output_must_contain_exactly_one_sha256_candidate() {
        let digest = "ABCDEF0123456789".repeat(4);
        assert_eq!(
            parse_certutil_sha256_output(
                format!("SHA256 hash of file:\r\n{digest}\r\nCertUtil: command completed successfully.\r\n")
                    .as_bytes()
            )
            .unwrap(),
            digest.to_ascii_lowercase()
        );
        for invalid in [
            b"CertUtil: command completed successfully.\r\n".to_vec(),
            format!("{digest}\r\n{digest}\r\n").into_bytes(),
            format!("{}0\r\n", digest).into_bytes(),
        ] {
            assert_eq!(
                parse_certutil_sha256_output(&invalid).unwrap_err().code,
                "package_checksum_output_invalid"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn timed_out_child_process_is_killed_without_waiting_for_natural_exit() {
        let cmd = std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32")
            .join("cmd.exe");
        let args = [
            OsString::from("/c"),
            OsString::from("ping"),
            OsString::from("-n"),
            OsString::from("6"),
            OsString::from("127.0.0.1"),
        ];
        let started = std::time::Instant::now();
        let result = super::run_wsl(&cmd, &args, std::time::Duration::from_millis(20));
        assert!(matches!(result, Err(WslCommandError::Timeout)));
        assert!(started.elapsed() < std::time::Duration::from_secs(3));
    }

    #[test]
    fn runtime_package_validation_requires_canonical_regular_tar_of_minimum_size() {
        let root =
            std::env::temp_dir().join(format!("koubo-runtime-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();

        let valid = root.join("runtime.TAR");
        let valid_file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&valid)
            .unwrap();
        valid_file.set_len(MIN_RUNTIME_TAR_BYTES).unwrap();
        drop(valid_file);
        assert_eq!(
            validate_runtime_tar(&valid).unwrap(),
            valid.canonicalize().unwrap()
        );

        let too_small = root.join("small.tar");
        std::fs::write(&too_small, b"not a runtime").unwrap();
        assert_eq!(
            validate_runtime_tar(&too_small).unwrap_err().code,
            "package_invalid"
        );

        let wrong_extension = root.join("runtime.zip");
        let wrong_file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&wrong_extension)
            .unwrap();
        wrong_file.set_len(MIN_RUNTIME_TAR_BYTES).unwrap();
        drop(wrong_file);
        assert_eq!(
            validate_runtime_tar(&wrong_extension).unwrap_err().code,
            "package_invalid"
        );

        let directory = root.join("directory.tar");
        std::fs::create_dir(&directory).unwrap();
        assert_eq!(
            validate_runtime_tar(&directory).unwrap_err().code,
            "package_invalid"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn runtime_manifest_and_executable_contract_paths_are_fixed() {
        let manifest = validate_runtime_manifest(
            br#"{"schemaVersion":1,"name":"KouboRuntime","version":"2026.07","apiUrl":"http://127.0.0.1:8383"}"#,
        )
        .unwrap();
        assert_eq!(manifest.version, "2026.07");
        assert_eq!(
            runtime_manifest_args(),
            vec![
                OsString::from("-d"),
                OsString::from("KouboRuntime"),
                OsString::from("--exec"),
                OsString::from("cat"),
                OsString::from("/etc/koubo-runtime.json"),
            ]
        );
        assert_eq!(
            runtime_executable_probe_args(),
            vec![
                OsString::from("-d"),
                OsString::from("KouboRuntime"),
                OsString::from("--exec"),
                OsString::from("test"),
                OsString::from("-x"),
                OsString::from("/opt/koubo/bin/koubo-runtime"),
            ]
        );
        assert_eq!(
            validate_runtime_manifest(
                br#"{"schemaVersion":1,"name":"Other","version":"1","apiUrl":"http://127.0.0.1:8383"}"#
            )
            .unwrap_err()
            .code,
            "package_invalid"
        );
    }

    #[test]
    fn runtime_lifecycle_uses_only_fixed_direct_wsl_arguments() {
        assert_eq!(
            runtime_start_args(),
            vec![
                OsString::from("-d"),
                OsString::from("KouboRuntime"),
                OsString::from("--exec"),
                OsString::from("/opt/koubo/bin/koubo-runtime"),
                OsString::from("start"),
            ]
        );
        assert_eq!(
            runtime_stop_args(),
            vec![
                OsString::from("-d"),
                OsString::from("KouboRuntime"),
                OsString::from("--exec"),
                OsString::from("/opt/koubo/bin/koubo-runtime"),
                OsString::from("stop"),
            ]
        );
        assert_eq!(
            runtime_terminate_args(),
            vec![
                OsString::from("--terminate"),
                OsString::from("KouboRuntime"),
            ]
        );
        assert_eq!(
            runtime_unregister_args(),
            vec![
                OsString::from("--unregister"),
                OsString::from("KouboRuntime"),
            ]
        );

        let flattened = [
            runtime_start_args(),
            runtime_stop_args(),
            runtime_terminate_args(),
            runtime_unregister_args(),
        ]
        .concat()
        .into_iter()
        .map(|value| value.to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_lowercase();
        for shell in ["powershell", "cmd.exe", "bash", "sh", "-c"] {
            assert!(!flattened.split_whitespace().any(|part| part == shell));
        }
        assert_eq!(flattened.matches("--unregister").count(), 1);
    }

    #[test]
    fn runtime_cleanup_removes_only_empty_directory_and_quarantines_content() {
        let root =
            std::env::temp_dir().join(format!("koubo-uninstall-test-{}", uuid::Uuid::new_v4()));
        let runtime_root = root.join("runtime");
        let install_dir = runtime_root.join(KOUBO_RUNTIME_DISTRO);
        std::fs::create_dir_all(&install_dir).unwrap();

        assert_eq!(
            super::quarantine_runtime_install_path(&install_dir).unwrap(),
            RuntimeInstallCleanup::RemovedEmptyDirectory
        );
        assert!(!install_dir.exists());

        std::fs::create_dir(&install_dir).unwrap();
        std::fs::write(install_dir.join("model.bin"), b"keep for recovery").unwrap();
        assert_eq!(
            super::quarantine_runtime_install_path(&install_dir).unwrap(),
            RuntimeInstallCleanup::Quarantined
        );
        assert!(!install_dir.exists());
        let quarantined = std::fs::read_dir(&runtime_root)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.file_name()
                    .and_then(|name| name.to_str())
                    .is_some_and(|name| name.starts_with("KouboRuntime.removed-"))
            })
            .expect("non-empty install path must be quarantined in the same parent");
        assert_eq!(
            std::fs::read(quarantined.join("model.bin")).unwrap(),
            b"keep for recovery"
        );

        std::fs::write(&install_dir, b"unexpected file").unwrap();
        assert_eq!(
            super::quarantine_runtime_install_path(&install_dir).unwrap(),
            RuntimeInstallCleanup::Quarantined
        );
        assert!(!install_dir.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn runtime_lifecycle_response_has_stable_source_status_and_error_code() {
        let response = RuntimeLifecycleResponse::failed(RuntimeImportError::new(
            "runtime_start_failed",
            "启动失败",
        ));
        let json = serde_json::to_value(response).unwrap();
        assert_eq!(json["status"], "failed");
        assert_eq!(json["source"], RUNTIME_LIFECYCLE_SOURCE);
        assert_eq!(json["message"], "启动失败");
        assert_eq!(json["error"]["code"], "runtime_start_failed");
        assert_eq!(json["error"]["message"], "启动失败");
    }

    #[test]
    fn runtime_import_and_lifecycle_share_one_operation_lock() {
        let _import_guard =
            RuntimeOperationGuard::acquire("import_in_progress", "KouboRuntime 正在执行其他操作。")
                .unwrap();
        let error =
            match RuntimeOperationGuard::acquire("runtime_busy", "KouboRuntime 正在执行其他操作。")
            {
                Ok(_) => panic!("shared runtime operation lock must reject overlap"),
                Err(error) => error,
            };
        assert_eq!(error.code, "runtime_busy");
    }

    #[test]
    fn wsl_distribution_output_decodes_utf16_without_nul_characters() {
        let encoded = "Ubuntu\r\nKouboRuntime\r\n"
            .encode_utf16()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>();
        assert_eq!(decode_wsl_text(&encoded), "Ubuntu\r\nKouboRuntime\r\n");
    }

    #[cfg(windows)]
    #[test]
    fn runtime_import_resolves_only_system32_wsl_executable() {
        let expected = std::path::PathBuf::from(std::env::var_os("SystemRoot").unwrap())
            .join("System32")
            .join("wsl.exe");
        assert_eq!(super::wsl_executable_path().unwrap(), expected);
    }
}
