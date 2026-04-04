import { v2 as cloudinary } from 'cloudinary';

cloudinary.config({
  cloud_name: 'drpppv5h0',
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

/**
 * Upload a base64 data URI to Cloudinary.
 * Returns the secure HTTPS URL of the uploaded image.
 */
export async function uploadBase64Image(dataUri: string): Promise<string> {
  const result = await cloudinary.uploader.upload(dataUri, {
    folder: 'food-delivery',
    resource_type: 'image',
  });
  return result.secure_url;
}
