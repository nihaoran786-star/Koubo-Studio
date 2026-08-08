export const PUBLISH_SELECTORS = {
  douyin: {
    authenticated: [
      'input[type="file"][accept*="video"]',
      '[class*="upload"] input[type="file"]',
      'input[placeholder*="作品标题"]',
    ],
    login: ['text=扫码登录', 'text=验证码登录', 'text=登录创作者中心'],
    video: ['input[type="file"][accept*="video"]', 'input[type="file"]'],
    title: [
      'input[placeholder*="作品标题"]',
      'input[placeholder*="填写标题"]',
      'textarea[placeholder*="作品标题"]',
    ],
    description: [
      'div[contenteditable="true"][data-placeholder*="作品描述"]',
      'div[contenteditable="true"][data-placeholder*="添加作品描述"]',
      'textarea[placeholder*="作品描述"]',
    ],
  },
  xiaohongshu: {
    authenticated: [
      'input[type="file"][accept*="video"]',
      '[class*="upload"] input[type="file"]',
      'input[placeholder*="填写标题"]',
    ],
    login: ['text=扫码登录', 'text=手机号登录', 'text=登录创作服务平台'],
    video: ['input[type="file"][accept*="video"]', 'input[type="file"]'],
    title: [
      'input[placeholder*="填写标题"]',
      'textarea[placeholder*="填写标题"]',
      'input[placeholder*="标题"]',
    ],
    description: [
      'div[contenteditable="true"][data-placeholder*="正文"]',
      'div[contenteditable="true"][data-placeholder*="描述"]',
      'textarea[placeholder*="正文"]',
    ],
  },
} as const
