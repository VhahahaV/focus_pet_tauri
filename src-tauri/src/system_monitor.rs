use serde::Serialize;
#[cfg(target_os = "macos")]
use std::process::Command;
use std::sync::Mutex;
use sysinfo::{Components, Disks, System};

pub struct SystemMonitorState {
    system: Mutex<System>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemMonitorCoreSample {
    name: String,
    usage: f32,
    frequency_m_hz: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemMonitorDiskSample {
    name: String,
    mount_point: String,
    total_bytes: u64,
    available_bytes: u64,
    usage: f32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemMonitorThermalSample {
    label: String,
    celsius: f32,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemMonitorFanSample {
    label: String,
    rpm: u64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SystemMetricsSample {
    sampled_at: String,
    cpu_usage: f32,
    cpu_name: String,
    cores: Vec<SystemMonitorCoreSample>,
    memory_total_bytes: u64,
    memory_used_bytes: u64,
    memory_usage: f32,
    disks: Vec<SystemMonitorDiskSample>,
    gpu_name: Option<String>,
    gpu_usage: Option<f32>,
    temperatures: Vec<SystemMonitorThermalSample>,
    fans: Vec<SystemMonitorFanSample>,
}

impl SystemMonitorState {
    pub fn new() -> Self {
        let mut system = System::new_all();
        std::thread::sleep(sysinfo::MINIMUM_CPU_UPDATE_INTERVAL);
        system.refresh_cpu_all();
        system.refresh_memory();
        Self {
            system: Mutex::new(system),
        }
    }

    pub fn sample(&self) -> Result<SystemMetricsSample, String> {
        let mut system = self
            .system
            .lock()
            .map_err(|_| "system monitor state is unavailable".to_string())?;
        system.refresh_cpu_all();
        system.refresh_memory();

        let cores = system
            .cpus()
            .iter()
            .enumerate()
            .map(|(index, cpu)| SystemMonitorCoreSample {
                name: if cpu.name().trim().is_empty() {
                    format!("Core {}", index + 1)
                } else {
                    cpu.name().to_string()
                },
                usage: clamp_percent(cpu.cpu_usage()),
                frequency_m_hz: cpu.frequency(),
            })
            .collect::<Vec<_>>();
        let cpu_name = system
            .cpus()
            .first()
            .map(|cpu| cpu.brand().trim())
            .filter(|name| !name.is_empty())
            .unwrap_or("CPU")
            .to_string();
        let memory_total_bytes = system.total_memory();
        let memory_used_bytes = system.used_memory();
        let memory_usage = ratio_percent(memory_used_bytes, memory_total_bytes);

        let disks = Disks::new_with_refreshed_list()
            .iter()
            .filter_map(|disk| {
                let total_bytes = disk.total_space();
                if total_bytes == 0 {
                    return None;
                }
                let available_bytes = disk.available_space();
                Some(SystemMonitorDiskSample {
                    name: disk.name().to_string_lossy().to_string(),
                    mount_point: disk.mount_point().to_string_lossy().to_string(),
                    total_bytes,
                    available_bytes,
                    usage: ratio_percent(total_bytes.saturating_sub(available_bytes), total_bytes),
                })
            })
            .collect::<Vec<_>>();

        let temperatures = Components::new_with_refreshed_list()
            .iter()
            .filter_map(|component| {
                component
                    .temperature()
                    .map(|celsius| SystemMonitorThermalSample {
                        label: component.label().to_string(),
                        celsius,
                    })
            })
            .collect::<Vec<_>>();
        let (gpu_name, gpu_usage) = apple_gpu_sample();

        Ok(SystemMetricsSample {
            sampled_at: chrono::Utc::now().to_rfc3339(),
            cpu_usage: clamp_percent(system.global_cpu_usage()),
            cpu_name,
            cores,
            memory_total_bytes,
            memory_used_bytes,
            memory_usage,
            disks,
            gpu_name,
            gpu_usage,
            temperatures,
            // macOS does not expose fan RPM through a stable public API. Keep the
            // contract optional so supported platforms can add readings later.
            fans: Vec::new(),
        })
    }
}

fn clamp_percent(value: f32) -> f32 {
    value.clamp(0.0, 100.0)
}

fn ratio_percent(used: u64, total: u64) -> f32 {
    if total == 0 {
        0.0
    } else {
        clamp_percent(used as f32 / total as f32 * 100.0)
    }
}

#[cfg(target_os = "macos")]
fn apple_gpu_sample() -> (Option<String>, Option<f32>) {
    let output = Command::new("/usr/sbin/ioreg")
        .args(["-r", "-d", "1", "-c", "AGXAccelerator"])
        .output();
    let Ok(output) = output else {
        return (None, None);
    };
    if !output.status.success() {
        return (None, None);
    }
    let text = String::from_utf8_lossy(&output.stdout);
    let usage = parse_number_after(&text, "\"Device Utilization %\"=").map(clamp_percent);
    let plugin = parse_quoted_value(&text, "\"MetalPluginClassName\" = \"");
    let name = if usage.is_some() || plugin.is_some() {
        Some(plugin.unwrap_or_else(|| "Apple GPU".to_string()))
    } else {
        None
    };
    (name, usage)
}

#[cfg(not(target_os = "macos"))]
fn apple_gpu_sample() -> (Option<String>, Option<f32>) {
    (None, None)
}

#[cfg(any(target_os = "macos", test))]
fn parse_number_after(text: &str, marker: &str) -> Option<f32> {
    let remainder = text.split_once(marker)?.1.trim_start();
    let end = remainder
        .find(|character: char| !character.is_ascii_digit() && character != '.')
        .unwrap_or(remainder.len());
    remainder[..end].parse::<f32>().ok()
}

#[cfg(any(target_os = "macos", test))]
fn parse_quoted_value(text: &str, marker: &str) -> Option<String> {
    let remainder = text.split_once(marker)?.1;
    let end = remainder.find('"')?;
    let value = remainder[..end].trim();
    (!value.is_empty()).then(|| value.to_string())
}

#[cfg(test)]
mod tests {
    use super::{parse_number_after, parse_quoted_value};

    #[test]
    fn parses_apple_gpu_statistics() {
        let sample = r#""MetalPluginClassName" = "AGXG16GDevice"
"PerformanceStatistics" = {"Device Utilization %"=29,"Renderer Utilization %"=28}"#;
        assert_eq!(
            parse_number_after(sample, "\"Device Utilization %\"="),
            Some(29.0)
        );
        assert_eq!(
            parse_quoted_value(sample, "\"MetalPluginClassName\" = \""),
            Some("AGXG16GDevice".to_string())
        );
    }
}
