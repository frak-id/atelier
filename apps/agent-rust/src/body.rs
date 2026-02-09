use http_body_util::BodyExt;
use hyper::body::Bytes;
use hyper::Request;

#[derive(Debug)]
pub enum ReadBodyError {
    TooLarge,
    ReadFailed,
}

pub async fn read_body_limited(
    req: Request<hyper::body::Incoming>,
    max_bytes: usize,
) -> Result<Bytes, ReadBodyError> {
    let mut body = req.into_body();
    let mut buf: Vec<u8> = Vec::new();
    // Avoid lots of tiny reallocations for small/medium payloads.
    buf.reserve(std::cmp::min(max_bytes, 64 * 1024));

    while let Some(frame_result) = body.frame().await {
        let frame = frame_result.map_err(|_| ReadBodyError::ReadFailed)?;

        if let Ok(data) = frame.into_data() {
            if buf.len().saturating_add(data.len()) > max_bytes {
                return Err(ReadBodyError::TooLarge);
            }
            buf.extend_from_slice(&data);
        }
    }

    Ok(Bytes::from(buf))
}
