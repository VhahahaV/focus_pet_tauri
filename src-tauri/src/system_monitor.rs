use serde::Serialize;
#[cfg(target_os = "macos")]
use std::process::Command;
use std::sync::{Arc, Mutex};
use sysinfo::{Components, Disks, System};

#[cfg(target_os = "windows")]
use std::collections::HashMap;

#[derive(Clone)]
pub struct SystemMonitorState {
    system: Arc<Mutex<System>>,
    #[cfg(target_os = "windows")]
    windows_gpu: Arc<Mutex<Option<WindowsGpuSampler>>>,
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
            system: Arc::new(Mutex::new(system)),
            #[cfg(target_os = "windows")]
            windows_gpu: Arc::new(Mutex::new(WindowsGpuSampler::new())),
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
        let (gpu_name, gpu_usage) = self.gpu_sample();

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

    fn gpu_sample(&self) -> (Option<String>, Option<f32>) {
        #[cfg(target_os = "windows")]
        {
            let usage = self
                .windows_gpu
                .lock()
                .ok()
                .and_then(|mut sampler| sampler.as_mut()?.sample());
            return (
                usage.map(|_| "Windows GPU (Performance Counters)".to_string()),
                usage,
            );
        }

        #[cfg(not(target_os = "windows"))]
        apple_gpu_sample()
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

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn apple_gpu_sample() -> (Option<String>, Option<f32>) {
    (None, None)
}

#[cfg(target_os = "windows")]
struct WindowsGpuSampler {
    query: usize,
    counter: usize,
}

#[cfg(target_os = "windows")]
impl WindowsGpuSampler {
    fn new() -> Option<Self> {
        use windows_sys::Win32::System::Performance::{
            PdhAddEnglishCounterW, PdhCollectQueryData, PdhOpenQueryW,
        };

        let mut query = std::ptr::null_mut();
        if unsafe { PdhOpenQueryW(std::ptr::null(), 0, &mut query) } != 0 || query.is_null() {
            return None;
        }
        let path = "\\GPU Engine(*)\\Utilization Percentage"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        let mut counter = std::ptr::null_mut();
        if unsafe { PdhAddEnglishCounterW(query, path.as_ptr(), 0, &mut counter) } != 0
            || counter.is_null()
        {
            unsafe { windows_sys::Win32::System::Performance::PdhCloseQuery(query) };
            return None;
        }
        // Rate counters require a baseline collection before a formatted value
        // can be produced by a later sample.
        if unsafe { PdhCollectQueryData(query) } != 0 {
            unsafe { windows_sys::Win32::System::Performance::PdhCloseQuery(query) };
            return None;
        }
        Some(Self {
            query: query as usize,
            counter: counter as usize,
        })
    }

    fn sample(&mut self) -> Option<f32> {
        use windows_sys::Win32::System::Performance::{
            PdhCollectQueryData, PdhGetFormattedCounterArrayW, PDH_FMT_COUNTERVALUE_ITEM_W,
            PDH_FMT_DOUBLE, PDH_MORE_DATA,
        };

        let query = self.query as _;
        let counter = self.counter as _;
        if unsafe { PdhCollectQueryData(query) } != 0 {
            return None;
        }
        let mut buffer_bytes = 0_u32;
        let mut item_count = 0_u32;
        let status = unsafe {
            PdhGetFormattedCounterArrayW(
                counter,
                PDH_FMT_DOUBLE,
                &mut buffer_bytes,
                &mut item_count,
                std::ptr::null_mut(),
            )
        };
        if status != PDH_MORE_DATA || buffer_bytes == 0 {
            return None;
        }
        let word_size = std::mem::size_of::<usize>();
        let mut buffer = vec![0_usize; (buffer_bytes as usize).div_ceil(word_size)];
        let status = unsafe {
            PdhGetFormattedCounterArrayW(
                counter,
                PDH_FMT_DOUBLE,
                &mut buffer_bytes,
                &mut item_count,
                buffer.as_mut_ptr().cast::<PDH_FMT_COUNTERVALUE_ITEM_W>(),
            )
        };
        if status != 0 || item_count == 0 {
            return None;
        }
        let items = unsafe {
            std::slice::from_raw_parts(
                buffer.as_ptr().cast::<PDH_FMT_COUNTERVALUE_ITEM_W>(),
                item_count as usize,
            )
        };
        let mut engines = HashMap::<String, f64>::new();
        for (index, item) in items.iter().enumerate() {
            if item.FmtValue.CStatus != 0 {
                continue;
            }
            let value = unsafe { item.FmtValue.Anonymous.doubleValue };
            if !value.is_finite() || value < 0.0 {
                continue;
            }
            let name = wide_string(item.szName);
            let key = gpu_engine_key(name.as_deref()).unwrap_or_else(|| format!("item-{index}"));
            *engines.entry(key).or_default() += value;
        }
        engines
            .values()
            .copied()
            .reduce(f64::max)
            .map(|usage| clamp_percent(usage as f32))
    }
}

#[cfg(target_os = "windows")]
impl Drop for WindowsGpuSampler {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::System::Performance::PdhCloseQuery(self.query as _);
        }
    }
}

#[cfg(target_os = "windows")]
fn wide_string(pointer: *mut u16) -> Option<String> {
    if pointer.is_null() {
        return None;
    }
    let mut length = 0_usize;
    unsafe {
        while *pointer.add(length) != 0 && length < 32_768 {
            length += 1;
        }
        (length > 0).then(|| String::from_utf16_lossy(std::slice::from_raw_parts(pointer, length)))
    }
}

#[cfg(target_os = "windows")]
fn gpu_engine_key(name: Option<&str>) -> Option<String> {
    let name = name?.to_ascii_lowercase();
    let start = name.find("luid_")?;
    let end = name[start..]
        .find("_engtype_")
        .map(|offset| start + offset)
        .unwrap_or(name.len());
    Some(name[start..end].to_string())
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

    #[cfg(target_os = "windows")]
    #[test]
    fn groups_windows_gpu_process_instances_by_physical_engine() {
        assert_eq!(
            super::gpu_engine_key(Some(
                "pid_100_luid_0x00000000_0x0000AABB_phys_0_eng_3_engtype_3D"
            )),
            Some("luid_0x00000000_0x0000aabb_phys_0_eng_3".to_string())
        );
    }
}
