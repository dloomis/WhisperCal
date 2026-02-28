interface MultipartField {
	name: string;
	value: string;
}

interface MultipartFile {
	name: string;
	filename: string;
	mimeType: string;
	data: ArrayBuffer;
}

interface MultipartResult {
	body: ArrayBuffer;
	contentType: string;
}

export function buildMultipartBody(fields: MultipartField[], file: MultipartFile): MultipartResult {
	const boundary = `----WhisperCal${Date.now()}${Math.random().toString(36).substring(2)}`;
	const encoder = new TextEncoder();
	const crlf = "\r\n";

	const parts: ArrayBuffer[] = [];

	for (const field of fields) {
		const header = `--${boundary}${crlf}Content-Disposition: form-data; name="${field.name}"${crlf}${crlf}`;
		parts.push(encoder.encode(header + field.value + crlf).buffer);
	}

	const fileHeader =
		`--${boundary}${crlf}` +
		`Content-Disposition: form-data; name="${file.name}"; filename="${file.filename}"${crlf}` +
		`Content-Type: ${file.mimeType}${crlf}${crlf}`;
	parts.push(encoder.encode(fileHeader).buffer);
	parts.push(file.data);
	parts.push(encoder.encode(crlf).buffer);

	const closing = `--${boundary}--${crlf}`;
	parts.push(encoder.encode(closing).buffer);

	const totalLength = parts.reduce((sum, buf) => sum + buf.byteLength, 0);
	const combined = new Uint8Array(totalLength);
	let offset = 0;
	for (const buf of parts) {
		combined.set(new Uint8Array(buf), offset);
		offset += buf.byteLength;
	}

	return {
		body: combined.buffer,
		contentType: `multipart/form-data; boundary=${boundary}`,
	};
}

const MIME_TYPES: Record<string, string> = {
	"webm": "audio/webm",
	"ogg": "audio/ogg",
	"mp3": "audio/mpeg",
	"m4a": "audio/mp4",
	"mp4": "audio/mp4",
	"wav": "audio/wav",
	"flac": "audio/flac",
};

export function audioMimeType(extension: string): string {
	return MIME_TYPES[extension.toLowerCase()] ?? "application/octet-stream";
}
