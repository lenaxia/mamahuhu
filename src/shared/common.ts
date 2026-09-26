/**
 * Common-word boost list (Traditional). The DP interpreter has no corpus
 * frequencies, so these high-frequency / parenting-relevant words get a score
 * bonus to beat obscure homophones (知道 vs 制導). Swap for SUBTLEX data later.
 */
export const COMMON_WORDS = new Set(
  `我 你 他 她 它 我們 你們 他們 這個 那個 這裡 那裡 什麼 為什麼 誰 哪裡 哪個 怎麼 怎麼樣
 的 了 嗎 呢 吧 啊 呀 唄
 是 有 在 要 想 去 來 看 聽 說 吃 喝 玩 坐 走 跑 拿 給 愛 喜歡 知道 覺得 會 能 可以 該 不 上 下 出 入 開 關
 不要 不吃 沒有 沒關係 不行 好了 對了
 你好 謝謝 再見 對不起 請 晚安 早安 午安 我愛你 好厲害 真棒 乖 聽話
 現在 今天 明天 昨天 早上 晚上 下午 白天 晚上
 爸爸 媽媽 哥哥 姊姊 弟弟 妹妹 寶寶 奶奶 爺爺 家人 朋友 老師
 好 壞 大 小 多 少 高 低 冷 熱 餓 累 忙 髒 乾淨 快 慢
 一 二 三 四 五 六 七 八 九 十 幾
 吃飯 喝水 睡覺 洗澡 尿布 刷牙 上廁所
 鞋子 衣服 褲子 袜子 帽子
 手 腳 眼睛 耳朵 鼻子 嘴巴 頭 頭髮 肚子 屁股
 飯 麵 麵包 水果 蘋果 香蕉 牛奶 果汁 餅乾 糖果 蔬菜 青菜 蛋 肉 湯
 貓 狗 魚 鳥 鴨子 牛 馬 豬
 說話 唱歌 跳舞 讀書 寫字 畫畫 看電視 講故事
 家 學校 外面 裡面 上面 下面 前面 後面 旁邊
 東西 因為 所以 但是 而且 如果 已經 還是 也 都 很 還 又 再 跟 和 對 從 到
 快一點 慢一點 等一下 小心 注意 危險
 時間 東西 事情 地方 名字
 過來 過去 起來 下去 出去 回家 出來
 好吃 好看 好玩 好睡 可愛`
    .split(/\s+/)
    .filter(Boolean)
);

export const isCommon = (traditional: string): boolean => COMMON_WORDS.has(traditional);
