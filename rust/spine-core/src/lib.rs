#![cfg_attr(target_arch = "wasm32", no_std)]

const PSD_MAGIC_LE: u32 = u32::from_le_bytes(*b"8BPS");

#[no_mangle]
pub extern "C" fn two_spine_api_version() -> u32 { 10400 }

#[no_mangle]
pub extern "C" fn two_spine_psd_header(magic: u32, version: u32, reserved: u32) -> u32 {
    u32::from(magic == PSD_MAGIC_LE && version == 1 && reserved == 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn validates_psd_v1_header() {
        assert_eq!(two_spine_psd_header(PSD_MAGIC_LE, 1, 0), 1);
        assert_eq!(two_spine_psd_header(PSD_MAGIC_LE, 2, 0), 0);
        assert_eq!(two_spine_psd_header(PSD_MAGIC_LE, 1, 1), 0);
    }
}
