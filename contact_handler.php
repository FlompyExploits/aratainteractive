<?php
header('Content-Type: application/json; charset=UTF-8');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['ok' => false, 'error' => 'Method not allowed']);
    exit;
}

$name = trim($_POST['name'] ?? '');
$email = trim($_POST['email'] ?? '');
$discord_id = trim($_POST['discord_id'] ?? '');
$topic = trim($_POST['topic'] ?? '');
$message = trim($_POST['message'] ?? '');
$inquiry = trim($_POST['inquiry_type'] ?? 'General Inquiry');

if ($name === '' || $email === '' || $topic === '' || $message === '') {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'Missing required fields']);
    exit;
}

if (!filter_var($email, FILTER_VALIDATE_EMAIL)) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'Invalid email']);
    exit;
}

$blocked_domains = [
    'mailinator.com','tempmail.com','10minutemail.com','guerrillamail.com','yopmail.com',
    'sharklasers.com','trashmail.com','getnada.com','dispostable.com','maildrop.cc',
    'fakeinbox.com','mozmail.com','example.com','example.org','example.net'
];
$email_domain = strtolower(substr(strrchr($email, "@"), 1));
if ($email_domain === '' || in_array($email_domain, $blocked_domains, true)) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'Email domain not allowed']);
    exit;
}
if (function_exists('checkdnsrr') && !checkdnsrr($email_domain, 'MX')) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'Email domain invalid']);
    exit;
}

$banned = [
    'fuck','shit','bitch','asshole','dumbass','nigger','faggot','retard','cunt','slut','whore'
];
$haystack = strtolower($name . ' ' . $topic . ' ' . $message);
foreach ($banned as $word) {
    if (strpos($haystack, $word) !== false) {
        http_response_code(400);
        echo json_encode(['ok' => false, 'error' => 'Message contains prohibited language']);
        exit;
    }
}

$webhook = 'https://discord.com/api/webhooks/1468029106137600263/E7GGO7hOkHlS1mhEN-066swOB-BAD-RNbN8AAzxud8wnlDUJwdiaIPDkNNv-hm0Z6Gh4';

$payload = json_encode([
    'username' => 'Arata Contact',
    'avatar_url' => 'https://cdn.discordapp.com/attachments/1456331351858090236/1467515681800060928/a_d916e0bf7d62d6b11ea0d3df8a126868.gif?ex=698152bb&is=6980013b&hm=db538f3ccc1eedf26cf5c7c91c7b870457c4ab742e34e23e5133cee8ca59427e&',
    'content' => '<@&1468017458987401330> <@&1468017377223376997>',
    'allowed_mentions' => [
        'roles' => ['1468017458987401330', '1468017377223376997']
    ],
    'embeds' => [
        [
            'title' => 'New Inquiry',
            'color' => 5814783,
            'fields' => [
                ['name' => 'Name', 'value' => $name, 'inline' => true],
                ['name' => 'Email', 'value' => $email, 'inline' => true],
                ['name' => 'Inquiry Type', 'value' => $inquiry, 'inline' => true],
                ['name' => 'Topic', 'value' => $topic, 'inline' => true],
                ['name' => 'Discord ID', 'value' => ($discord_id !== '' ? $discord_id : 'N/A'), 'inline' => true],
                ['name' => 'Message', 'value' => "```\n" . $message . "\n```", 'inline' => false],
            ],
        ]
    ]
]);

if (function_exists('curl_init')) {
    $ch = curl_init($webhook);
    curl_setopt($ch, CURLOPT_POST, true);
    curl_setopt($ch, CURLOPT_POSTFIELDS, $payload);
    curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_TIMEOUT, 10);
    $response = curl_exec($ch);
    $err = curl_error($ch);
    $status = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_close($ch);
} else {
    $ctx = stream_context_create([
        'http' => [
            'method' => 'POST',
            'header' => "Content-Type: application/json\r\n",
            'content' => $payload,
            'timeout' => 10
        ]
    ]);
    $response = @file_get_contents($webhook, false, $ctx);
    $status = 0;
    if (isset($http_response_header[0])) {
        if (preg_match('/\\s(\\d{3})\\s/', $http_response_header[0], $m)) {
            $status = (int)$m[1];
        }
    }
    $err = $response === false ? 'file_get_contents failed' : '';
}

if ($response === false || $status >= 400) {
    http_response_code(500);
    echo json_encode(['ok' => false, 'error' => 'Failed to send message', 'detail' => $err ?: ('HTTP ' . $status)]);
    exit;
}

echo json_encode(['ok' => true]);
exit;
