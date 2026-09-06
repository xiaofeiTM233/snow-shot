use snow_shot_http_services::{S3Config, S3Service};

pub mod translation;

pub async fn upload_to_s3(
    endpoint: String,
    region: String,
    access_key_id: String,
    secret_access_key: String,
    bucket: String,
    path_prefix: Option<String>,
    force_path_style: bool,
    data: &[u8],
    filename: String,
    content_type: Option<String>,
) -> Result<String, String> {
    let config = S3Config {
        endpoint,
        region,
        access_key_id,
        secret_access_key,
        bucket,
        path_prefix,
        force_path_style,
    };

    let service = S3Service::new(config).await.map_err(|e| e.to_string())?;

    let url = service
        .upload_bytes(data, filename, content_type)
        .await
        .map_err(|e| e.to_string())?;

    Ok(url)
}
