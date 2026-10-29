/**
 * /about/ 下的服务条款、隐私政策、风险揭露（三种语言）。
 * 参照 forecast main 0caa740 web/site/src/content/legal.ts（交易客户端的完整版）改写成**上线前网站**的版本：
 * 只写这个网站现在真实做到的（介绍玩法、留邮箱、确认、退订、邀请统计、名单页、行情来源），产品上线后的玩法写"以客户端写明的为准"。
 * 不写牌照、监管、公司主体、联系地址（写"待提供"）；不写诱导收益的说法（稳赚、翻倍等）。品牌 Quick Come。
 * 繁中用台湾用语（電子信箱、資料、網路、伺服器；参照 forecast S18 的用语处理）。三种语言的章节数、每节段落数一致（site/test/web/content.test.ts 检查）。
 * 正式使用前需要法务审核（页面上标着）。
 */
import type { Lang } from '../../../shared/rules';

export type LegalPage = 'terms' | 'privacy' | 'risk';

export interface LegalSection {
  h: string;
  p: string[];
}

export interface LegalDoc {
  title: string;
  intro: string[];
  sections: LegalSection[];
}

export const LEGAL_UPDATED = '2026-10-29';
const BRAND = 'Quick Come';

const termsTw: LegalDoc = {
  title: '服務條款',
  intro: [
    `本服務條款適用於你對 ${BRAND} 網站（上線前的介紹和等候頁，以下稱「本網站」）的使用。留下電子信箱即表示你已閱讀並同意本條款、《隱私政策》和《風險揭露》。`,
    '本網站的營運主體、註冊地、適用法律和爭議解決方式：待提供。',
  ],
  sections: [
    { h: '1. 本網站是什麼', p: [`本網站是 ${BRAND} 預測產品上線前的網站，用來介紹玩法、讓你留下電子信箱收上線通知。本網站不提供註冊、充值、下注或提現，也沒有這些入口。`] },
    {
      h: '2. 產品預計的玩法',
      p: [
        '產品上線後用 USDT 參與，玩法是彩池（pari-mutuel）：每一場是一個獎池，贏的一方按押注比例分輸方的獎池；平台不當對手，只從贏家的盈利裡收取抽成（預設 5%）。只有一邊有人押時，這一場取消、全額退還。',
        '以上是上線前的說明，費率、支援的鏈、提現門檻等以上線後客戶端寫明的規則為準。',
      ],
    },
    {
      h: '3. 留電子信箱和確認',
      p: ['留下電子信箱後，我們會寄一封確認郵件，你在頁面上按「確認訂閱」才算訂閱（確認連結 7 天內有效）。確認以後，我們只在正式上線時寄一封通知，不寄其他郵件；每封郵件都可以退訂。'],
    },
    { h: '4. 邀請連結', p: ['確認訂閱後你會拿到一個專屬邀請連結，用來統計你邀請了幾個人。目前邀請不附帶任何獎勵或返佣。查看人數的專屬頁面只給你自己看，請不要轉給別人。'] },
    { h: '5. 內測', p: ['勾選「願意參加內測」只表示你的意願，不保證一定會被邀請；內測開始前我們會另外寄信聯絡。'] },
    {
      h: '6. 網站上的資料',
      p: ['返獎率對照、焦點戰和 BTC 行情只供參考。焦點戰的開賽時間以各聯賽官方公布為準；BTC 行情來自 OKX、幣安、KuCoin、Gate 或 Kraken 的公開資料，每 5 分鐘更新一次，可能延遲或暫時取不到。'],
    },
    { h: '7. 年齡和所在地區', p: ['你需要年滿 18 歲，並自行確認在你所在的國家或地區使用預測產品是合法的。'] },
    { h: '8. 條款變更和聯絡', p: ['本條款可能隨產品上線更新，更新後的版本公布在本頁。聯絡信箱：待提供。'] },
  ],
};

const termsZh: LegalDoc = {
  title: '服务条款',
  intro: [
    `本服务条款适用于你对 ${BRAND} 网站（上线前的介绍和等候页，以下称"本网站"）的使用。留下邮箱即表示你已阅读并同意本条款、《隐私政策》和《风险披露》。`,
    '本网站的运营主体、注册地、适用法律和争议解决方式：待提供。',
  ],
  sections: [
    { h: '1. 本网站是什么', p: [`本网站是 ${BRAND} 预测产品上线前的网站，用来介绍玩法、让你留下邮箱收上线通知。本网站不提供注册、充值、下注或提现，也没有这些入口。`] },
    {
      h: '2. 产品预计的玩法',
      p: [
        '产品上线后用 USDT 参与，玩法是彩池（pari-mutuel）：每一场是一个奖池，赢的一方按押注比例分输方的奖池；平台不当对手，只从赢家的盈利里收取抽成（默认 5%）。只有一边有人押时，这一场取消、全额退还。',
        '以上是上线前的说明，费率、支持的链、提现门槛等以上线后客户端写明的规则为准。',
      ],
    },
    {
      h: '3. 留邮箱和确认',
      p: ['留下邮箱后，我们会发一封确认邮件，你在页面上点"确认订阅"才算订阅（确认链接 7 天内有效）。确认以后，我们只在正式上线时发一封通知，不发其他邮件；每封邮件都可以退订。'],
    },
    { h: '4. 邀请链接', p: ['确认订阅后你会拿到一个专属邀请链接，用来统计你邀请了几个人。目前邀请不附带任何奖励或返佣。查看人数的专属页面只给你自己看，请不要转给别人。'] },
    { h: '5. 内测', p: ['勾选"愿意参加内测"只表示你的意愿，不保证一定会被邀请；内测开始前我们会另外发邮件联系。'] },
    {
      h: '6. 网站上的数据',
      p: ['返奖率对照、焦点战和 BTC 行情只供参考。焦点战的开赛时间以各联赛官方公布为准；BTC 行情来自 OKX、币安、KuCoin、Gate 或 Kraken 的公开数据，每 5 分钟更新一次，可能延迟或暂时取不到。'],
    },
    { h: '7. 年龄和所在地区', p: ['你需要年满 18 周岁，并自行确认在你所在的国家或地区使用预测产品是合法的。'] },
    { h: '8. 条款变更和联系', p: ['本条款可能随产品上线更新，更新后的版本公布在本页。联系邮箱：待提供。'] },
  ],
};

const termsEn: LegalDoc = {
  title: 'Terms of Service',
  intro: [
    `These Terms of Service apply to your use of the ${BRAND} website (the pre-launch introduction and waitlist, the "Website"). By leaving your email you confirm that you have read and agree to these Terms, the Privacy Policy and the Risk Disclosure.`,
    'Operator, place of registration, governing law and dispute resolution: to be provided.',
  ],
  sections: [
    { h: '1. What the Website is', p: [`The Website is the pre-launch site of the ${BRAND} prediction product. It explains how the product works and lets you leave your email for the launch notice. The Website offers no sign-up, deposits, betting or withdrawals, and has no entry points for them.`] },
    {
      h: '2. How the product is expected to work',
      p: [
        'After launch you take part with USDT on a pari-mutuel (pool) basis: every game is a pool, and the winning side shares the losing side’s pool in proportion to their stakes. The platform is never your counterparty and only takes a fee on winners’ profit (5% by default). If only one side has bets, the game is cancelled and refunded in full.',
        'This is a pre-launch description; fees, supported networks, withdrawal thresholds and other rules shown in the client app after launch apply.',
      ],
    },
    {
      h: '3. Leaving your email and confirming',
      p: ['After you leave your email we send a confirmation email; you are subscribed only after you click "Confirm" on the page (the link is valid for 7 days). Once confirmed, we send a single email at launch and nothing else; every email lets you unsubscribe.'],
    },
    { h: '4. Invite links', p: ['After confirming you get a personal invite link, used only to count how many people you have invited. Invites currently carry no reward or commission. The private page that shows the count is for you only; please do not share it.'] },
    { h: '5. Beta', p: ['Ticking "I’d like to join the beta" only records your interest and does not guarantee an invitation; we will email you separately before the beta starts.'] },
    {
      h: '6. Information on the Website',
      p: ['The return-rate comparison, featured games and BTC data are for reference only. Kick-off times follow each league’s official schedule; BTC data comes from OKX, Binance, KuCoin, Gate or Kraken public market data, is refreshed every 5 minutes, and may be delayed or temporarily unavailable.'],
    },
    { h: '7. Age and location', p: ['You must be at least 18 and are responsible for making sure that using a prediction product is lawful where you live.'] },
    { h: '8. Changes and contact', p: ['These Terms may be updated as the product launches; the current version is published on this page. Contact email: to be provided.'] },
  ],
};

const privacyTw: LegalDoc = {
  title: '隱私政策',
  intro: [`本隱私政策說明 ${BRAND} 網站收集哪些個人資料、為什麼收集、怎樣使用、保存和保護。`, '個人資料的處理者（營運主體）和聯絡地址：待提供。'],
  sections: [
    {
      h: '1. 我們收集的資料',
      p: ['你留下的電子信箱、介面語言、是否勾選「願意參加內測」；網址上的來源標記（例如從哪個社群貼文、哪位訂閱者的邀請連結點進來）；送出時 IP 位址的雜湊值（只存不可還原的結果，不存原文）；留信箱、確認、退訂的時間。'],
    },
    {
      h: '2. 我們怎樣使用',
      p: ['寄確認郵件和上線通知；統計各來源「訪問 → 確認」的比例和邀請人數；限制同一來源送出的次數，防止濫用。訪問統計只按天、按來源計數，不記 IP 或裝置編號。'],
    },
    { h: '3. 我們不做的事', p: ['我們不出售你的個人資料，也不用於廣告投放；本網站不使用任何第三方統計、廣告或追蹤程式碼，也不載入第三方字型。'] },
    {
      h: '4. 保存和保護',
      p: ['資料存放在 Cloudflare 的資料庫，傳輸加密。名單只有營運者用密碼登入名單頁才能查看，頁面上的電子信箱是打碼的；完整名單只在產品上線、導入正式系統時匯出一次。'],
    },
    { h: '5. 和第三方共享', p: ['寄信服務商（Resend）只拿到收件地址和信件內容；網站由 Cloudflare 託管。法律要求時按要求提供。'] },
    { h: '6. 你的權利', p: ['每封郵件裡都有退訂連結，按下就不會再收到郵件。需要查詢、更正或刪除個人資料時，可以聯絡我們：待提供。'] },
    { h: '7. 瀏覽器本地儲存', p: ['網站用瀏覽器本地儲存記住你選的語言，用工作階段儲存記住這次瀏覽的來源參數（關掉分頁就清除）。我們不使用廣告或追蹤 Cookie。'] },
  ],
};

const privacyZh: LegalDoc = {
  title: '隐私政策',
  intro: [`本隐私政策说明 ${BRAND} 网站收集哪些个人信息、为什么收集、怎样使用、保存和保护。`, '个人信息的处理者（运营主体）和联系地址：待提供。'],
  sections: [
    {
      h: '1. 我们收集的信息',
      p: ['你留下的邮箱、界面语言、是否勾选"愿意参加内测"；网址上的来源标记（例如从哪个社交媒体帖子、哪位订阅者的邀请链接点进来）；提交时 IP 地址的哈希值（只存不可还原的结果，不存原文）；留邮箱、确认、退订的时间。'],
    },
    {
      h: '2. 我们怎样使用',
      p: ['发确认邮件和上线通知；统计各来源"访问 → 确认"的比例和邀请人数；限制同一来源提交的次数，防止滥用。访问统计只按天、按来源计数，不记 IP 或设备编号。'],
    },
    { h: '3. 我们不做的事', p: ['我们不出售你的个人信息，也不用于广告投放；本网站不使用任何第三方统计、广告或追踪代码，也不加载第三方字体。'] },
    {
      h: '4. 保存和保护',
      p: ['数据存放在 Cloudflare 的数据库，传输加密。名单只有运营者用密码登录名单页才能查看，页面上的邮箱是打码的；完整名单只在产品上线、导入正式系统时导出一次。'],
    },
    { h: '5. 和第三方共享', p: ['发信服务商（Resend）只拿到收件地址和邮件内容；网站由 Cloudflare 托管。法律要求时按要求提供。'] },
    { h: '6. 你的权利', p: ['每封邮件里都有退订链接，点了就不会再收到邮件。需要查询、更正或删除个人信息时，可以联系我们：待提供。'] },
    { h: '7. 浏览器本地存储', p: ['网站用浏览器本地存储记住你选的语言，用会话存储记住这次浏览的来源参数（关掉标签页就清除）。我们不使用广告或追踪 Cookie。'] },
  ],
};

const privacyEn: LegalDoc = {
  title: 'Privacy Policy',
  intro: [`This Privacy Policy explains what personal information the ${BRAND} website collects, why, and how it is used, stored and protected.`, 'Data controller (operator) and contact address: to be provided.'],
  sections: [
    {
      h: '1. Information we collect',
      p: ['The email you leave, your interface language and whether you ticked "I’d like to join the beta"; source tags in the address (e.g. which social post or which subscriber’s invite link you came from); a hash of your IP address when you submit (only the irreversible hash is stored, never the address itself); and the times you subscribed, confirmed or unsubscribed.'],
    },
    {
      h: '2. How we use it',
      p: ['To send the confirmation email and the launch notice; to measure "visit → confirm" rates per source and invite counts; and to limit repeated submissions from the same source to prevent abuse. Visit statistics are counted per day and per source only, without IP addresses or device IDs.'],
    },
    { h: '3. What we do not do', p: ['We do not sell your personal information or use it for advertising. The Website uses no third-party analytics, advertising or tracking code, and loads no third-party fonts.'] },
    {
      h: '4. Storage and protection',
      p: ['Data is stored in a Cloudflare database and encrypted in transit. Only the operator can view the list, by signing in to the list page with a password, and emails are masked there; the full list is exported only once, when the product launches and the list is imported into the production system.'],
    },
    { h: '5. Sharing with third parties', p: ['Our email provider (Resend) receives only the recipient address and the email content; the Website is hosted by Cloudflare. We provide information when the law requires it.'] },
    { h: '6. Your rights', p: ['Every email contains an unsubscribe link; once you use it you will receive no more emails. To access, correct or delete your personal information, contact us: to be provided.'] },
    { h: '7. Browser storage', p: ['The Website uses local storage to remember your language, and session storage to remember this visit’s source parameters (cleared when you close the tab). We do not use advertising or tracking cookies.'] },
  ],
};

const riskTw: LegalDoc = {
  title: '風險揭露',
  intro: [`本風險揭露說明參與 ${BRAND} 預測的主要風險，但不能列出全部風險。請在參與前讀完。`],
  sections: [
    { h: '1. 你可能損失全部本金', p: ['預測有輸有贏：你押的選項輸了，你在這個選項上的本金會全部損失。過去的結果不代表以後的結果。請只用你能承受損失的資金參與。'] },
    { h: '2. 賠率在截止前會變', p: ['彩池玩法的賠率取決於兩邊獎池的比例，截止前隨著別人下注不斷變化；最終回報按截止時的獎池計算，可能比你下注時看到的低。'] },
    { h: '3. 押中也可能拿得少', p: ['押中的人越多、輸方獎池越小，盈利越少；平台對盈利收取抽成。首頁的返獎率是按兩邊押注各半計算的，實際比例隨每一場的獎池變化。'] },
    { h: '4. 區塊鏈和資金', p: ['區塊鏈上的轉帳一旦確認就不能撤回；轉錯網路、轉錯地址或轉入其他代幣無法找回。不同鏈的手續費差很多，小額用 TRC20 可能被手續費吃掉將近一成。USDT 本身的價格、發行方和所在區塊鏈的風險由你自行承擔。'] },
    { h: '5. 上線前的資訊可能變動', p: ['本網站介紹的費率、支援的鏈、提現門檻和上線日期都是上線前的說明，可能調整，以上線後客戶端寫明的為準。'] },
    { h: '6. 法律和監管', p: ['你有責任確認使用預測產品符合你所在國家或地區的法律。監管與牌照資訊：待提供。本網站的內容不構成投資建議。'] },
  ],
};

const riskZh: LegalDoc = {
  title: '风险披露',
  intro: [`本风险披露说明参与 ${BRAND} 预测的主要风险，但不能列出全部风险。请在参与前读完。`],
  sections: [
    { h: '1. 你可能损失全部本金', p: ['预测有输有赢：你押的选项输了，你在这个选项上的本金会全部损失。过去的结果不代表以后的结果。请只用你能承受损失的资金参与。'] },
    { h: '2. 赔率在截止前会变', p: ['彩池玩法的赔率取决于两边奖池的比例，截止前随着别人下注不断变化；最终回报按截止时的奖池计算，可能比你下注时看到的低。'] },
    { h: '3. 押中也可能拿得少', p: ['押中的人越多、输方奖池越小，盈利越少；平台对盈利收取抽成。首页的返奖率是按两边押注各半计算的，实际比例随每一场的奖池变化。'] },
    { h: '4. 区块链和资金', p: ['区块链上的转账一旦确认就不能撤回；转错网络、转错地址或转入其他代币无法找回。不同链的手续费差很多，小额用 TRC20 可能被手续费吃掉将近一成。USDT 本身的价格、发行方和所在区块链的风险由你自行承担。'] },
    { h: '5. 上线前的信息可能变动', p: ['本网站介绍的费率、支持的链、提现门槛和上线日期都是上线前的说明，可能调整，以上线后客户端写明的为准。'] },
    { h: '6. 法律和监管', p: ['你有责任确认使用预测产品符合你所在国家或地区的法律。监管与牌照信息：待提供。本网站的内容不构成投资建议。'] },
  ],
};

const riskEn: LegalDoc = {
  title: 'Risk Disclosure',
  intro: [`This Risk Disclosure describes the main risks of making predictions on ${BRAND}, but it cannot list every risk. Please read it before you take part.`],
  sections: [
    { h: '1. You may lose your whole stake', p: ['Predictions can be lost: if the option you backed loses, your whole stake on that option is lost. Past results do not predict future results. Only use money you can afford to lose.'] },
    { h: '2. Odds change until the close', p: ['In a pool-based game the odds depend on the relative size of the two pools and keep changing as others bet until the close; your final return is calculated from the pools at the close and may be lower than what you saw when you bet.'] },
    { h: '3. Winning may pay less than expected', p: ['The more people back the winning side and the smaller the losing pool, the smaller the profit; the platform takes a fee on profit. The return rate on the home page assumes stakes split evenly; the real figure varies with each game’s pools.'] },
    { h: '4. Blockchain and funds', p: ['A confirmed blockchain transfer cannot be reversed; transfers on the wrong network, to the wrong address or of other tokens cannot be recovered. Fees vary a lot between networks, and on TRC20 the fee can eat up nearly 10% of a small transfer. You bear the risks of USDT itself, its issuer and the blockchains it runs on.'] },
    { h: '5. Pre-launch information may change', p: ['Fees, supported networks, withdrawal thresholds and the launch date described on this Website are pre-launch information and may change; the rules shown in the client app after launch apply.'] },
    { h: '6. Legal and regulatory', p: ['You are responsible for making sure that using a prediction product is lawful where you live. Regulatory and licence information: to be provided. Nothing on this Website is investment advice.'] },
  ],
};

export const LEGAL: Record<LegalPage, Record<Lang, LegalDoc>> = {
  terms: { 'zh-TW': termsTw, 'zh-CN': termsZh, en: termsEn },
  privacy: { 'zh-TW': privacyTw, 'zh-CN': privacyZh, en: privacyEn },
  risk: { 'zh-TW': riskTw, 'zh-CN': riskZh, en: riskEn },
};
