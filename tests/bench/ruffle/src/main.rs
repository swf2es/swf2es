use std::{env, fs, hint::black_box, time::Instant};
use swf::{avm2::read::Reader, extensions::ReadSwfExt};

fn run(bytes: &[u8], decode: bool) -> usize {
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

fn time(mut f: impl FnMut() -> usize) -> (f64, usize, Vec<f64>) {
    for _ in 0..3 {
        black_box(f());
    }
    let start = Instant::now();
    black_box(f());
    let rounds = (40.0 / (start.elapsed().as_secs_f64() * 1000.0).max(0.01))
        .round()
        .max(1.0) as usize;
    let mut samples = Vec::new();
    for _ in 0..5 {
        let start = Instant::now();
        for _ in 0..rounds {
            black_box(f());
        }
        samples.push(start.elapsed().as_secs_f64() * 1000.0 / rounds as f64);
    }
    let mut sorted = samples.clone();
    sorted.sort_by(f64::total_cmp);
    (sorted[2], rounds, samples)
}

fn main() {
    let file = env::args()
        .nth(1)
        .expect("usage: swf2es-ruffle-bench file.abc");
    let bytes = fs::read(file).expect("read ABC");
    let methods = run(&bytes, false);
    let instructions = run(&bytes, true);
    let (parse_ms, parse_rounds, parse_samples) = time(|| run(&bytes, false));
    let (total_ms, total_rounds, total_samples) = time(|| run(&bytes, true));
    println!(
        "{{\"tool\":\"Ruffle\",\"methods\":{methods},\"instructions\":{instructions},\"parseMs\":{parse_ms},\"totalMs\":{total_ms},\"parseRounds\":{parse_rounds},\"totalRounds\":{total_rounds},\"parseSamples\":{parse_samples:?},\"totalSamples\":{total_samples:?}}}"
    );
}
