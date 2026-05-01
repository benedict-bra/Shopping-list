// =============================================================================
// PHOTO COMPRESSION
// =============================================================================
// Photos from phones are huge (3-5MB+). We resize down to 400px max dimension
// and re-encode as JPEG at 70% quality, which gives ~30-80KB per photo.
// =============================================================================

const MAX_DIMENSION = 400;
const QUALITY = 0.7;

export async function compressImage(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (e) => {
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        let { width, height } = img;
        if (width > height && width > MAX_DIMENSION) {
          height = (height * MAX_DIMENSION) / width;
          width = MAX_DIMENSION;
        } else if (height > MAX_DIMENSION) {
          width = (width * MAX_DIMENSION) / height;
          height = MAX_DIMENSION;
        }
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL('image/jpeg', QUALITY));
      };
      img.onerror = () => reject(new Error('Could not load image'));
      img.src = e.target.result;
    };
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.readAsDataURL(file);
  });
}
