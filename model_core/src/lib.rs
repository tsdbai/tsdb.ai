// Required attribute for Wasm compilation targets
#[no_mangle]
pub extern "C" fn calculate_rmse(original_ptr: *const f64, reconstructed_ptr: *const f64, len: usize) -> f64 {
    let original = unsafe { std::slice::from_raw_parts(original_ptr, len) };
    let reconstructed = unsafe { std::slice::from_raw_parts(reconstructed_ptr, len) };
    
    if len == 0 {
        return 0.0;
    }
    
    let mut sum_sq: f64 = 0.0;
    for i in 0..len {
        let diff = original[i] - reconstructed[i];
        sum_sq += diff * diff;
    }
    
    (sum_sq / len as f64).sqrt()
}

// Helper function to get the mean (used internally by model fit)
fn get_average(values: &[f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    values.iter().sum::<f64>() / values.len() as f64
}

// --- Model 0: Constant Model Reconstruction ---
// Params: c
#[no_mangle]
pub extern "C" fn reconstruct_constant(t_ptr: *const f64, len: usize, c: f64, result_ptr: *mut f64) {
    let result = unsafe { std::slice::from_raw_parts_mut(result_ptr, len) };
    for i in 0..len {
        result[i] = c;
    }
}

// --- Model 1: Linear Model Reconstruction ---
// Params: m, c
#[no_mangle]
pub extern "C" fn reconstruct_linear(t_ptr: *const f64, len: usize, m: f64, c: f64, result_ptr: *mut f64) {
    let t = unsafe { std::slice::from_raw_parts(t_ptr, len) };
    let result = unsafe { std::slice::from_raw_parts_mut(result_ptr, len) };
    for i in 0..len {
        result[i] = m * t[i] + c;
    }
}

// --- Model 2: Quadratic Model Reconstruction ---
// Params: a, b, c
#[no_mangle]
pub extern "C" fn reconstruct_quadratic(t_ptr: *const f64, len: usize, a: f64, b: f64, c: f64, result_ptr: *mut f64) {
    let t = unsafe { std::slice::from_raw_parts(t_ptr, len) };
    let result = unsafe { std::slice::from_raw_parts_mut(result_ptr, len) };
    for i in 0..len {
        let t_val = t[i];
        result[i] = a * t_val * t_val + b * t_val + c;
    }
}

// Note: The simple_linear_fit function (which uses math/arrays) is more complex 
// to implement without high-level Wasm bindings (like wasm-bindgen) or a custom memory 
// allocator, so we focus on the essential reconstruction logic for the prototype.
