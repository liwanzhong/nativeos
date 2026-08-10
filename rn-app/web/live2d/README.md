# Live2D 模型素材目录

## 目录结构

将你的 Live2D Cubism 4 模型文件放在这个目录下，每个角色一个子目录：

```
web/live2d/
├── README.md               ← 本文件
├── senko/                  ← 示例：角色名称
│   ├── senko.model3.json   ← 必须：主配置文件（入口）
│   ├── senko.moc3          ← 必须：模型网格数据
│   ├── senko.physics3.json ← 可选：物理参数（头发/衣服抖动）
│   ├── senko.cdi3.json     ← 可选：显示信息
│   ├── textures/
│   │   ├── texture_00.png  ← 必须：皮肤贴图（可能有多个）
│   │   └── texture_01.png
│   └── motions/
│       ├── idle_01.motion3.json   ← 待机动作
│       ├── idle_02.motion3.json
│       └── talk_01.motion3.json   ← 说话动作（isSpeaking 时触发）
└── haru/                   ← 另一个角色
    └── haru.model3.json
```

## 如何接入

在沉浸式沙盒场景页面 `app/scenario/[id]-immersive.tsx` 中，
通过 `SCENARIO_DB` 里的 `modelUrl` 字段指定模型路径：

```ts
'4': {
  // ...
  modelUrl: '/live2d/senko/senko.model3.json',
}
```

或者在 `<Live2DAvatar>` 组件传入 prop：

```tsx
<Live2DAvatar
  modelUrl="/live2d/senko/senko.model3.json"
  npcEmoji="🧑‍🍳"
  isSpeaking={isTtsSpeaking}
/>
```

## 素材来源

- **自制模型**：用 Live2D Cubism Editor 导出 → 选择 "Runtime" 格式 → 得到 `.model3.json` + `.moc3` + 纹理
- **免费模型**：
  - [nizima LIVE 免费模型](https://nizima.com/live/)
  - [GitHub pixi-live2d-display test assets](https://github.com/guansss/pixi-live2d-display/tree/master/test/assets)
  - [Booth.pm 创作者模型](https://booth.pm) （注意授权协议）

## 注意事项

1. 必须是 **Cubism 4 格式**（`.model3.json`），不支持旧版 Cubism 2/3
2. 模型文件放在 `web/` 子目录下，Expo Metro 会将其作为静态文件 serve
3. 路径以 `/live2d/` 开头（相对于 web 服务器根目录）
4. 本地开发时（`expo start --web`）访问 `http://localhost:19006/live2d/模型名/model.model3.json` 确认能访问
