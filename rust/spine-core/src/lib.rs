//! v1.4.0: dependency-free Rust/WASM validation foundation for the website.
//! The renderer and Spine exports remain in the existing browser generator.
#![cfg_attr(target_arch = "wasm32", no_std)]

#[cfg(target_arch = "wasm32")]
#[panic_handler]
fn wasm_panic(_info: &core::panic::PanicInfo<'_>) -> ! {
    loop {
        core::hint::spin_loop();
    }
}

const MAX_ATLAS: u32 = 8192;
const PSD_MAGIC_LE: u32 = u32::from_le_bytes(*b"8BPS");

#[no_mangle]
pub extern "C" fn two_spine_api_version() -> u32 {
    10400 // major.minor.patch = 1.4.0
}

/// Magic is little-endian ASCII 8BPS; version is big-endian 16-bit PSD v1.
/// Reserved words represent all six reserved bytes from PSD header.
#[no_mangle]
pub extern "C" fn two_spine_psd_header(
    magic_le: u32,
    version: u32,
    reserved_first_four: u32,
    reserved_last_two: u32,
) -> u32 {
    u32::from(
        magic_le == PSD_MAGIC_LE
            && version == 1
            && reserved_first_four == 0
            && reserved_last_two == 0
    )
}

/// Validate one atlas region using checked, non-overflowing bounds.
#[no_mangle]
pub extern "C" fn two_spine_atlas_region(
    atlas_width: u32,
    atlas_height: u32,
    x: u32,
    y: u32,
    width: u32,
    height: u32,
) -> u32 {
    if atlas_width == 0 || atlas_height == 0 ||
        atlas_width > MAX_ATLAS || atlas_height > MAX_ATLAS ||
        width == 0 || height == 0 {
        return 0;
    }
    match (x.checked_add(width), y.checked_add(height)) {
        (Some(right), Some(bottom)) if right <= atlas_width && bottom <= atlas_height => 1,
        _ => 0,
    }
}

/// Check that key timings stay ordered and within the requested clip duration.
#[no_mangle]
pub extern "C" fn two_spine_timeline(start_ms: u32, end_ms: u32, duration_ms: u32) -> u32 {
    u32::from(start_ms <= end_ms && end_ms <= duration_ms && duration_ms <= 30_000)
}


/// Manual edge entries are pairs, and a stray entry is invalid.
/// Edges are optional nonessential data in the Spine JSON export format.
#[no_mangle]
pub extern "C" fn two_spine_mesh_edge_count(count: u32) -> u32 {
    u32::from(count <= 2_000_000 && count % 2 == 0)
}

/// Both canonical vertex indices and even interleaved-coordinate indices are
/// encountered in third-party importers. Check bounds without overflowing.
#[no_mangle]
pub extern "C" fn two_spine_mesh_edge_index(index: u32, vertices: u32, coordinate_mode: u32) -> u32 {
    if vertices < 3 || vertices > 1_000_000 {
        return 0;
    }
    match coordinate_mode {
        0 => u32::from(index < vertices),
        1 => u32::from(index % 2 == 0 && vertices.checked_mul(2).is_some_and(|end| index < end)),
        _ => 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn psd_rejects_psb_and_nonzero_reserved() {
        assert_eq!(two_spine_psd_header(PSD_MAGIC_LE, 1, 0, 0), 1);
        assert_eq!(two_spine_psd_header(PSD_MAGIC_LE, 2, 0, 0), 0);
        assert_eq!(two_spine_psd_header(PSD_MAGIC_LE, 1, 1, 0), 0);
    }
    #[test]
    fn atlas_rejects_overflow_and_bad_dimensions() {
        assert_eq!(two_spine_atlas_region(2048, 2048, 12, 15, 8, 11), 1);
        assert_eq!(two_spine_atlas_region(2048, 2048, 2040, 15, 9, 11), 0);
        assert_eq!(two_spine_atlas_region(2048, 2048, u32::MAX, 0, 4, 4), 0);
        assert_eq!(two_spine_atlas_region(8193, 2048, 0, 0, 8, 11), 0);
    }
    #[test]
    fn mesh_edges_require_complete_pairs_and_valid_vertex_indices() {
        assert_eq!(two_spine_mesh_edge_count(0), 1);
        assert_eq!(two_spine_mesh_edge_count(6), 1);
        assert_eq!(two_spine_mesh_edge_count(1), 0);
        assert_eq!(two_spine_mesh_edge_count(2_000_001), 0);
        assert_eq!(two_spine_mesh_edge_index(2, 3, 0), 1);
        assert_eq!(two_spine_mesh_edge_index(3, 3, 0), 0);
        assert_eq!(two_spine_mesh_edge_index(4, 3, 1), 1);
        assert_eq!(two_spine_mesh_edge_index(3, 3, 1), 0);
        assert_eq!(two_spine_mesh_edge_index(u32::MAX, 3, 1), 0);
    }
    #[test]
    fn timeline_rejects_reversed_and_outside_keyframes() {
        assert_eq!(two_spine_timeline(0, 300, 1000), 1);
        assert_eq!(two_spine_timeline(400, 300, 1000), 0);
        assert_eq!(two_spine_timeline(100, 1001, 1000), 0);
    }
}
