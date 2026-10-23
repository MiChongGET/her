# Her 与 Samantha 视觉设计 · v1

## 已确认的方向

- Her 是产品，Samantha 是有独立人物形象的私人女性伙伴。
- 气质：知性、亲近、有主见，成熟而自然。
- Logo：以小写 h 为骨架，柔和、略有手写感；单色轮廓方便小尺寸使用。
- 头像：真实人物比例的简洁插画，东亚成年女性，视觉年龄约 28 岁，深色齐肩发，平视并有轻微笑意。
- 共用暖白、浅灰绿和深灰绿。Logo 使用 #66765d 与 #f8f7f3。

## 资产

| 文件 | 用途 |
| --- | --- |
| her-logo.svg | 透明底品牌符号，可缩放 |
| her-app-icon.svg | 暖白圆角方底应用图标 |
| her-logo-monochrome.svg | 黑色单色标，可供菜单栏模板使用 |
| samantha-avatar.png | Samantha 插画头像原图 |
| preview.html | Logo、头像与小尺寸使用预览 |

SVG 使用同一原创路径，不依赖字体。头像由内置 imagegen 生成；先生成原创人物，再保留身份调整为明确的绘画风格。此目录为设计资产，现有应用源码尚未接入这套新资源。

## 头像提示词

### 原创人物生成

Use case: stylized-concept
Asset type: Standalone square portrait avatar for Samantha, the original adult female private AI companion in the desktop application Her. Deliver one finished image, approximately 1024x1024, no presentation board.
Subject: An original East Asian woman, apparent age about 28, dark shoulder-length hair, softly tucked behind one ear, natural human facial proportions. Intelligent, warm, self-possessed, approachable. She looks directly at the viewer with attentive eyes and a subtle relaxed smile, as though she is listening carefully.
Style/medium: Refined simplified portrait illustration with realistic human proportions. Clear shapes, restrained fine painterly texture, softly rendered natural skin, deliberately illustrated rather than photographic. Tasteful, quiet, adult, enduring.
Composition: Front-facing head and upper shoulders, centered, close enough that her face is very readable at a 32px circular crop. Preserve the whole crown with generous breathing room above and to the sides. Eyes sit a little above the center. Calm uncluttered silhouette. No hands.
Clothing: Simple understated sage-green knit top, relaxed neckline, no visible jewelry or decorative accessories.
Lighting/mood: Soft warm daylight, gentle form and a calm attentive presence.
Palette: Warm ivory background #f8f7f3; muted light gray-green #e6e9df; sage-green clothing around #8fa375 / #66765d; dark charcoal-brown hair; natural warm skin. Background is a single quiet warm ivory field with only a very subtle soft tonal variation.
Constraints: Original character identity. Natural modest proportions, visible adult maturity, gentle and individual facial character. No lettering, no name, no logo, no watermark, no frame, no circular border, no props, no busy background. Avoid glossy beauty retouching, exaggerated eyes, anime conventions, plastic 3D rendering, futuristic equipment, heavy makeup or fashion-ad posing.

### 插画风格修订

Use case: style-transfer
Edit target: The attached Samantha portrait.
Change ONLY the rendering medium to a clearly hand-painted editorial portrait illustration. Preserve this original woman's facial identity, apparent adult age around 28, East Asian features, shoulder-length dark hair, direct attentive gaze, slight smile, head-and-shoulders composition, sage sweater and warm ivory background.
Required style: restrained contemporary gouache portrait, realistic human proportions, simplified large painted color planes, soft deliberate brush marks, gently defined features with sparse linework, solid grouped locks of hair. Facial features should remain individual and natural. Visible artist-made shapes and matte pigment edges make the whole image unmistakably an illustration. Skin is rendered in a few warm painted tones; clothing uses simple shapes and a few broad brushstrokes.
Keep the palette quiet and warm: ivory #f8f7f3 backdrop, muted sage clothing, charcoal-brown hair. Keep the face readable as a tiny circular chat avatar.
Remove photographic microdetail such as skin pores, individual flyaway strands and every knit stitch. No photography, no airbrushed photo effect, no 3D, no anime, no text, no added objects or decoration.
Output one finished square portrait, not a board.
