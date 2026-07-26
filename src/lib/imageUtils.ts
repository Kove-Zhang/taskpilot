/**
 * 图像压缩与格式转换工具库
 * 专为 TaskPilot 优化本地存储与大模型 Token 传输设计
 */

/**
 * 压缩 File/Blob 对象图像为轻量级 JPEG Base64
 * @param file 原始图像文件对象
 * @param maxDim 最大边长限制 (默认 1920px)
 * @param quality JPEG 压缩质量 (0.1 ~ 1.0, 默认 0.8)
 */
export async function compressImage(file: File | Blob, maxDim: number = 1920, quality: number = 0.8): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = (event) => {
      const resultStr = event.target?.result as string;
      if (!resultStr) {
        return reject(new Error('文件读取为空'));
      }
      compressBase64Image(resultStr, maxDim, quality)
        .then(resolve)
        .catch(reject);
    };
    reader.onerror = () => reject(new Error('文件读取失败'));
    reader.readAsDataURL(file);
  });
}

/**
 * 压缩任意 Base64 格式图像（支持 Data URL 或纯 Base64 字符串）为轻量级 JPEG Base64
 * @param base64Str 原始 Base64 数据
 * @param maxDim 最大边长限制 (默认 1280px，针对邮箱图片优化体积)
 * @param quality JPEG 压缩质量 (默认 0.75)
 */
export async function compressBase64Image(base64Str: string, maxDim: number = 1280, quality: number = 0.75): Promise<string> {
  return new Promise((resolve) => {
    if (!base64Str) {
      return resolve(base64Str);
    }

    // 规范化 Data URL 前缀
    let dataUrl = base64Str;
    if (!dataUrl.startsWith('data:')) {
      dataUrl = `data:image/jpeg;base64,${dataUrl}`;
    }

    const img = new Image();
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas');
        let width = img.width;
        let height = img.height;

        if (width > maxDim || height > maxDim) {
          if (width > height) {
            height = Math.round((height * maxDim) / width);
            width = maxDim;
          } else {
            width = Math.round((width * maxDim) / height);
            height = maxDim;
          }
        }

        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (ctx) {
          // 填充白色背景以防止 PNG 透明区域转为黑色
          ctx.fillStyle = '#ffffff';
          ctx.fillRect(0, 0, width, height);
          ctx.drawImage(img, 0, 0, width, height);
          const compressed = canvas.toDataURL('image/jpeg', quality);
          resolve(compressed);
        } else {
          // 如果 Canvas 上下文获取失败，降级返回原数据
          resolve(dataUrl);
        }
      } catch (err) {
        console.warn('Canvas 图像压缩过程中出现异常，降级返回原图', err);
        resolve(dataUrl);
      }
    };

    img.onerror = () => {
      console.warn('无法解析传入的 Base64 图像数据，降级返回原数据');
      resolve(base64Str);
    };

    img.src = dataUrl;
  });
}
