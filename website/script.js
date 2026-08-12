// ===== Lucide 图标初始化 =====
if (window.lucide) lucide.createIcons();

// ===== NAV 滚动效果 =====
const nav = document.getElementById('nav');
window.addEventListener('scroll', () => {
  nav.classList.toggle('scrolled', window.scrollY > 20);
});

// ===== 汉堡菜单 =====
const hamburger = document.getElementById('hamburger');
const navMobile = document.getElementById('nav-mobile');
hamburger.addEventListener('click', () => {
  navMobile.classList.toggle('open');
});
// 点击移动端菜单链接后关闭
navMobile.querySelectorAll('a').forEach(a => {
  a.addEventListener('click', () => navMobile.classList.remove('open'));
});

// ===== 滚动入场动画 =====
const reveals = document.querySelectorAll('.reveal');
const observer = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      entry.target.classList.add('visible');
      observer.unobserve(entry.target);
    }
  });
}, { threshold: 0.12 });
reveals.forEach(el => observer.observe(el));

// ===== 给各 section 内部元素加 reveal =====
document.querySelectorAll(
  '.step, .feature-card, .video-feature, .lib-point, .callout, .faq-item'
).forEach((el, i) => {
  el.classList.add('reveal');
  el.style.transitionDelay = `${(i % 4) * 80}ms`;
});
// 重新观察（因为是动态添加的）
document.querySelectorAll('.reveal').forEach(el => observer.observe(el));

// ===== 平滑锚点 + 关闭移动菜单 =====
document.querySelectorAll('a[href^="#"]').forEach(link => {
  // 排除下载按钮（href 会由 JS 异步填成真实 URL）
  if (link.classList.contains('js-download')) return;
  link.addEventListener('click', e => {
    const target = document.querySelector(link.getAttribute('href'));
    if (target) {
      e.preventDefault();
      const top = target.getBoundingClientRect().top + window.scrollY - 72;
      window.scrollTo({ top, behavior: 'smooth' });
    }
  });
});

// ===== 应用下载信息 (从 /api/version.json 拉取) =====
const APP_UPDATE_CACHE_KEY = 'nativeos_app_update';
const APP_UPDATE_CACHE_TTL = 5 * 60 * 1000; // 5 分钟

function formatAppFileSize(bytes) {
  if (!bytes || bytes <= 0) return null;
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  if (mb >= 10) return `${mb.toFixed(0)} MB`;
  return `${mb.toFixed(1)} MB`;
}

function formatAppDate(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function renderAppUpdateInfo(manifest) {
  const downloadBtn = document.querySelector('.js-download');
  if (!downloadBtn) return;

  // 1. 按钮 href
  if (manifest.downloadUrl) {
    downloadBtn.href = manifest.downloadUrl;
    downloadBtn.setAttribute('download', '');
  }

  // 2. 版本信息行
  const versionEl = document.querySelector('.js-version-info');
  if (versionEl) {
    const nameEl = document.querySelector('.js-version-name');
    const sizeEl = document.querySelector('.js-version-size');
    const dateEl = document.querySelector('.js-version-date');
    if (nameEl && manifest.versionName) nameEl.textContent = `v${manifest.versionName}`;
    const sizeLabel = formatAppFileSize(manifest.apkSizeBytes);
    if (sizeEl) sizeEl.textContent = sizeLabel || '—';
    const dateLabel = formatAppDate(manifest.publishedAt);
    if (dateEl) dateEl.textContent = dateLabel ? `${dateLabel} 更新` : '—';
    versionEl.hidden = false;
  }

  // 3. 更新内容折叠面板
  const notes = Array.isArray(manifest.releaseNotes) ? manifest.releaseNotes : [];
  const releaseContainer = document.querySelector('.js-release-notes');
  const releaseList = document.querySelector('.js-release-list');
  if (releaseContainer && releaseList) {
    releaseList.innerHTML = '';
    if (notes.length > 0) {
      notes.forEach(note => {
        const li = document.createElement('li');
        li.textContent = note;
        releaseList.appendChild(li);
      });
      releaseContainer.hidden = false;
    }
  }

  // 4. 二维码
  const qrSection = document.querySelector('.js-qr-section');
  const qrCanvas = document.querySelector('.js-qr-canvas');
  if (qrSection && qrCanvas && manifest.downloadUrl && window.QRious) {
    try {
      new QRious({
        element: qrCanvas,
        value: manifest.downloadUrl,
        size: 140,
        background: '#ffffff',
        foreground: '#0F172A',
        level: 'M',
      });
      qrSection.hidden = false;
    } catch (err) {
      console.warn('QR code generation failed', err);
    }
  }
}

function showAppUpdateError() {
  const downloadBtn = document.querySelector('.js-download');
  if (downloadBtn) {
    // 失败兜底：用 data-fallback-url
    const fallback = downloadBtn.getAttribute('data-fallback-url');
    if (fallback) downloadBtn.href = fallback;
  }
  const errorEl = document.querySelector('.js-version-error');
  if (errorEl) errorEl.hidden = false;
}

async function loadAppUpdateInfo() {
  const downloadBtn = document.querySelector('.js-download');
  if (!downloadBtn) return; // 当前页没有下载区

  // 1. 尝试用缓存
  try {
    const cached = localStorage.getItem(APP_UPDATE_CACHE_KEY);
    if (cached) {
      const { manifest, ts } = JSON.parse(cached);
      if (Date.now() - ts < APP_UPDATE_CACHE_TTL) {
        renderAppUpdateInfo(manifest);
        return;
      }
    }
  } catch (err) {
    // 缓存读取失败不阻塞主流程
  }

  // 2. 拉远端
  try {
    const manifestUrl = 'https://nativeos.oss-cn-beijing.aliyuncs.com/app/android/version.json';
    const res = await fetch(manifestUrl, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const manifest = await res.json();
    renderAppUpdateInfo(manifest);
    try {
      localStorage.setItem(APP_UPDATE_CACHE_KEY, JSON.stringify({
        manifest,
        ts: Date.now(),
      }));
    } catch (err) {
      // localStorage 写入失败 (隐私模式 / 满) 忽略
    }
  } catch (err) {
    console.warn('App update manifest fetch failed', err);
    showAppUpdateError();
  }
}

loadAppUpdateInfo().catch(err => console.warn('loadAppUpdateInfo rejected', err));
