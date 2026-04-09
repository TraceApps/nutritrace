/**
 * camera.js — Platform-aware photo capture.
 * On native: opens the camera directly via @capacitor/camera (no file picker).
 * On web: returns null (caller should fall back to <input type="file">).
 */
import { isNative } from './platform.js';

/**
 * Take a photo using the native camera. Returns a File object or null.
 * On web, returns null — the caller should use the standard file input.
 */
export async function takePhoto() {
  if (!isNative) return null;

  const { Camera, CameraResultType, CameraSource } = await import('@capacitor/camera');

  const photo = await Camera.getPhoto({
    resultType: CameraResultType.Uri,
    source: CameraSource.Camera,  // Open camera directly — Upload button handles gallery
    quality: 85,
    allowEditing: false,
  });

  // Convert the URI to a File object for upload
  const response = await fetch(photo.webPath);
  const blob = await response.blob();
  const ext = photo.format || 'jpeg';
  return new File([blob], `photo_${Date.now()}.${ext}`, { type: `image/${ext}` });
}
