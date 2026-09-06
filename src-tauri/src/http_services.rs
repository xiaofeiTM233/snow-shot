use snow_shot_app_utils::{
    get_request_bool_header, get_request_optional_string_header, get_request_string_header,
};
use tauri::command;

#[command]
pub async fn upload_to_s3(request: tauri::ipc::Request<'_>) -> Result<String, String> {
    let data = match request.body() {
        tauri::ipc::InvokeBody::Raw(data) => data,
        _ => return Err(String::from("[upload_to_s3] Invalid request body")),
    };

    let endpoint: String = get_request_string_header(&request, "x-endpoint")?;
    let region: String = get_request_string_header(&request, "x-region")?;
    let access_key_id: String = get_request_string_header(&request, "x-access-key-id")?;
    let secret_access_key: String = get_request_string_header(&request, "x-secret-access-key")?;
    let bucket: String = get_request_string_header(&request, "x-bucket")?;
    let path_prefix: Option<String> =
        get_request_optional_string_header(&request, "x-path-prefix")?;
    let force_path_style: bool = get_request_bool_header(&request, "x-force-path-style")?;
    let filename: String = get_request_string_header(&request, "x-filename")?;
    let content_type: Option<String> =
        get_request_optional_string_header(&request, "x-content-type")?;

    snow_shot_tauri_commands_http_service::upload_to_s3(
        endpoint,
        region,
        access_key_id,
        secret_access_key,
        bucket,
        path_prefix,
        force_path_style,
        data,
        filename,
        content_type,
    )
    .await
}
