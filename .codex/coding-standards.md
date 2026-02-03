# Codex 编码规范

## 团队编码标准

### 目标

保持回答和代码风格一致、简洁、安全、可复用，遵循团队 UI 体系。

## 语言规范

### 交流语言

- 所有说明、回复、文档：**简体中文**
- 技术讨论保持中文表达的准确性

### 代码语言

```typescript
// ✅ 推荐：中文注释
/**
 * 计算图像的最佳裁剪区域
 * @param imageData 原始图像数据
 * @param targetAspectRatio 目标宽高比
 */
function calculateOptimalCropArea(
  imageData: ImageData,
  targetAspectRatio: number,
) {
  // 人脸检测逻辑
  const faceDetection = detectFaces(imageData);

  // 根据人脸位置调整裁剪区域
  return adjustCropForFaces(faceDetection, targetAspectRatio);
}

// ❌ 避免：过度英文化
// Calculate optimal crop area for image processing
```

## 代码质量要求

### 1. 简洁性原则

```typescript
// ✅ 好的实现
const isPortraitWithFace = (image: ImageInfo) =>
  image.height > image.width && image.hasFaces;

// ❌ 过度复杂
const determineImageOrientationAndFacePresenceStatus = (
  imageInformation: ImageInformation,
) => {
  if (imageInformation.dimensionHeight > imageInformation.dimensionWidth) {
    if (
      imageInformation.faceDetectionResults &&
      imageInformation.faceDetectionResults.length > 0
    ) {
      return true;
    }
  }
  return false;
};
```

### 2. 圈复杂度控制

```typescript
// ✅ 推荐：清晰的条件分支
function getCropStrategy(image: ImageInfo): CropStrategy {
  if (image.isPortrait && image.hasFaces) {
    return new PortraitFaceCropStrategy();
  }

  if (image.isLandscape) {
    return new LandscapeCropStrategy();
  }

  return new DefaultCropStrategy();
}

// ❌ 避免：复杂嵌套
function getCropStrategy(image: ImageInfo) {
  if (image.width > image.height) {
    if (image.hasFaces) {
      if (image.faceCount > 1) {
        // 深层嵌套...
      }
    }
  } else {
    // 更多嵌套...
  }
}
```

### 3. 复用性设计

```typescript
// ✅ 抽取公共逻辑
const cropStrategies = {
  portrait: new PortraitCropStrategy(),
  landscape: new LandscapeCropStrategy(),
  square: new SquareCropStrategy(),
};

function applyCropStrategy(image: ImageData, strategyType: string) {
  const strategy = cropStrategies[strategyType];
  return strategy.crop(image);
}
```

## 架构设计原则

### 模块划分

```
src/
├── utils/           # 工具函数
│   ├── image.ts     # 图像处理工具
│   └── math.ts      # 数学计算工具
├── services/        # 业务服务
│   ├── cropService.ts
│   └── faceDetectionService.ts
├── types/           # 类型定义
│   └── image.ts
└── components/      # UI 组件
    └── ImageCropper.vue
```

### 设计模式应用

```typescript
// Strategy 模式 - 裁剪策略
interface CropStrategy {
  crop(image: ImageData, targetRatio: number): CropResult;
}

// Factory 模式 - 策略创建
class CropStrategyFactory {
  static create(imageType: ImageType): CropStrategy {
    switch (imageType) {
      case ImageType.Portrait:
        return new PortraitCropStrategy();
      case ImageType.Landscape:
        return new LandscapeCropStrategy();
      default:
        return new DefaultCropStrategy();
    }
  }
}
```

## 改动最小化原则

### 影响评估模板

```markdown
## 变更影响分析

- **改动文件**：[列出所有修改文件]
- **影响模块**：[相关业务模块]
- **破坏性变更**：[是否有 API 变更]
- **测试范围**：[需要验证的功能]

## 回滚计划

1. 代码回滚：git revert [commit-hash]
2. 数据迁移：[如有必要]
3. 配置恢复：[环境配置变更]
```

## 交付标准

### 代码提交格式

```typescript
/**
 * 人像图像智能裁剪优化
 *
 * 功能说明：
 * - 针对竖向人像图片，优化裁剪策略
 * - 保证人脸完整显示
 * - 支持多人脸场景
 *
 * 注意事项：
 * - 需要先进行人脸检测
 * - 裁剪比例建议 height >= width
 *
 * @param image 输入图像数据
 * @param options 裁剪选项
 * @returns 优化后的裁剪区域
 */
export function optimizedPortraitCrop(
  image: ImageData,
  options: CropOptions,
): CropArea {
  // 实现逻辑
}
```

### 文档交付要求

1. **中文功能说明**
2. **使用示例代码**
3. **注意事项列表**
4. **API 参数说明**
5. **错误处理说明**

这些规范确保代码质量一致性，提高团队协作效率。
