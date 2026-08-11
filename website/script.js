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
  link.addEventListener('click', e => {
    const target = document.querySelector(link.getAttribute('href'));
    if (target) {
      e.preventDefault();
      const top = target.getBoundingClientRect().top + window.scrollY - 72;
      window.scrollTo({ top, behavior: 'smooth' });
    }
  });
});
