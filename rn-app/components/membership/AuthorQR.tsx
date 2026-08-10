/**
 * 作者微信二维码展示组件
 *
 * 复用 contact-author 页面已用的 assets/contact-author/author-wechat-qr.jpg
 * 不另存 PNG 副本 — 同一张图给两个场景用：
 *   1. /contact-author 页面 (top-level 入口)
 *   2. /membership 底部 Bottom Sheet "联系作者" tab
 *
 * 接受的 trade-off: APK 里的 author-wechat-qr.jpg 谁都能解包拿到。
 * 独立开发者个人分发，圈外人加你微信的需求 > 防泄漏需求。
 * 真要保密就改成后端下发, 但跟 "1 块发一张码" 的模式不匹配。
 */

import React from 'react';
import { Image, StyleSheet, View } from 'react-native';
import { borderRadius, colors } from '../../constants/theme';

const AUTHOR_QR_IMAGE = require('../../assets/contact-author/author-wechat-qr.jpg');
// 提前 resolve 一次 — 拿到真实宽高比, 渲染时按比例展示不被裁
const AUTHOR_QR_SOURCE = Image.resolveAssetSource(AUTHOR_QR_IMAGE);

export function AuthorQR({ size = 220 }: { size?: number }) {
  const aspect =
    AUTHOR_QR_SOURCE && AUTHOR_QR_SOURCE.width > 0 && AUTHOR_QR_SOURCE.height > 0
      ? AUTHOR_QR_SOURCE.width / AUTHOR_QR_SOURCE.height
      : 1;
  // 图片本身已经包含白底和静默区, container 只需要浅边框做卡片感
  const w = size;
  const h = Math.round(size / aspect);
  return (
    <View style={styles.frame}>
      <Image
        source={AUTHOR_QR_IMAGE}
        style={{ width: w, height: h }}
        resizeMode="contain"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  frame: {
    padding: 6,
    backgroundColor: '#FFFFFF',
    borderRadius: borderRadius.md,
    borderWidth: 1,
    borderColor: colors.border.default,
  },
});
