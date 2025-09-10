<?php
header('Content-Type: application/json');

function vidoza_upload($apiToken, $file, $params = array())
{
    // Get upload server
    $ch = curl_init('https://api.vidoza.net/v1/upload/http/server');
    $authorization = "Authorization: Bearer " . $apiToken;
    curl_setopt($ch, CURLOPT_HTTPHEADER, array('Content-Type: application/json', $authorization));
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, 1);
    curl_setopt($ch, CURLOPT_TIMEOUT, 30);
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
    
    $res = curl_exec($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    
    if (curl_error($ch)) {
        curl_close($ch);
        return array('success' => false, 'message' => 'Failed to connect to Vidoza API: ' . curl_error($ch));
    }
    
    if ($httpCode != 200) {
        curl_close($ch);
        return array('success' => false, 'message' => 'API request failed with status: ' . $httpCode);
    }
    
    curl_close($ch);
    
    $res = json_decode($res);
    if (!$res || !isset($res->data)) {
        return array('success' => false, 'message' => 'Invalid API response');
    }

    // POST variables
    $postParams = array();
    foreach (array_merge((array) $res->data->upload_params, $params) as $field => $value) {
        $postParams[$field] = $value;
    }
    
    if (function_exists('curl_file_create')) { // php 5.5+
        $postParams['file'] = curl_file_create($file);
    } else {
        $postParams['file'] = '@' . realpath($file);
    }

    // Upload file
    $ch = curl_init($res->data->upload_url);
    curl_setopt($ch, CURLOPT_POST, 1);
    curl_setopt($ch, CURLOPT_POSTFIELDS, $postParams);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, 1);
    curl_setopt($ch, CURLOPT_TIMEOUT, 0); // No timeout for file upload
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false);
    
    $postResult = curl_exec($ch);
    
    if (curl_errno($ch)) {
        $error = curl_error($ch);
        curl_close($ch);
        return array('success' => false, 'message' => 'Upload failed: ' . $error);
    }
    
    curl_close($ch);
    
    $uploadRes = json_decode($postResult, true);
    if (!$uploadRes || $uploadRes['status'] != 'OK') {
        $errorMsg = isset($uploadRes['message']) ? $uploadRes['message'] : 'Unknown upload error';
        return array('success' => false, 'message' => 'Upload error: ' . $errorMsg);
    }
    
    // Return success with file code
    return array(
        'success' => true, 
        'message' => 'Video uploaded successfully!',
        'file_code' => $uploadRes['data']['file_code'],
        'url' => 'https://vidoza.net/' . $uploadRes['data']['file_code'] . '.html'
    );
}

// Handle the upload request
if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    // Check if file was uploaded
    if (!isset($_FILES['videoFile']) || $_FILES['videoFile']['error'] !== UPLOAD_ERR_OK) {
        echo json_encode(array('success' => false, 'message' => 'No file uploaded or upload error'));
        exit;
    }
    
    $uploadedFile = $_FILES['videoFile'];
    
    // Validate file type (basic validation)
    $allowedTypes = array('video/mp4', 'video/avi', 'video/mov', 'video/wmv', 'video/flv', 'video/webm');
    if (!in_array($uploadedFile['type'], $allowedTypes)) {
        echo json_encode(array('success' => false, 'message' => 'Invalid file type. Please upload a video file.'));
        exit;
    }
    
    // Check file size (limit to 500MB)
    $maxSize = 500 * 1024 * 1024; // 500MB in bytes
    if ($uploadedFile['size'] > $maxSize) {
        echo json_encode(array('success' => false, 'message' => 'File too large. Maximum size is 500MB.'));
        exit;
    }
    
    $apiToken = 'p1wihap3sbuapwz9fdctvw9wy7wmabbqnqrohit1rr2hdm2gnzieixaxtflf';
    $tempFile = $uploadedFile['tmp_name'];
    
    // Upload to Vidoza
    $result = vidoza_upload($apiToken, $tempFile);
    
    echo json_encode($result);
} else {
    echo json_encode(array('success' => false, 'message' => 'Invalid request method'));
}
?>
