use std::hint::black_box;
use swf::{avm2::read::Reader, extensions::ReadSwfExt};

pub fn run(bytes: &[u8], decode: bool) -> usize {
    let abc = Reader::new(black_box(bytes)).read().expect("invalid ABC");
    let mut count = abc.methods.len();
    if decode {
        count = 0;
        for body in &abc.method_bodies {
            let mut reader = Reader::new(&body.code);
            let mut ops = Vec::new();
            while !reader.as_slice().is_empty() {
                ops.push(reader.read_op().expect("invalid opcode"));
            }
            count += ops.len();
            black_box(&ops);
        }
    }
    black_box(&abc);
    black_box(count)
}

// The JS wrapper owns this allocation until bench_free, including across memory growth.
#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub extern "C" fn bench_alloc(len: usize) -> *mut u8 {
    Box::into_raw(vec![0u8; len].into_boxed_slice()) as *mut u8
}

/// # Safety
/// `ptr` and `len` must describe a live allocation returned by bench_alloc.
#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bench_free(ptr: *mut u8, len: usize) {
    unsafe { drop(Box::from_raw(std::ptr::slice_from_raw_parts_mut(ptr, len))) };
}

/// # Safety
/// The input allocation must remain live and unchanged throughout this call.
#[cfg(target_arch = "wasm32")]
#[unsafe(no_mangle)]
pub unsafe extern "C" fn bench_run(ptr: *const u8, len: usize, rounds: u32, decode: u32) -> usize {
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) };
    let mut count = 0;
    for _ in 0..rounds {
        count = run(bytes, decode != 0);
    }
    count
}
