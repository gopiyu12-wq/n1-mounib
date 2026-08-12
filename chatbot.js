// Self-contained store assistant — no external API, nothing leaves the server.
// Answers common customer questions from the live store data. It is hard-locked
// to never reveal how or where the site was built, or any internal tech details.

// --- Text helpers ------------------------------------------------------------
// Normalize Arabic: strip diacritics/tatweel, unify alef/ya/ta-marbuta, lowercase latin.
function normalize(s) {
  return String(s || '')
    .replace(/[\u064B-\u0652\u0640]/g, '')      // harakat + tatweel
    .replace(/[\u0622\u0623\u0625]/g, '\u0627') // آ أ إ -> ا
    .replace(/\u0649/g, '\u064A')               // ى -> ي
    .replace(/\u0629/g, '\u0647')               // ة -> ه
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')          // drop punctuation
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function hasAny(text, words) {
  return words.some(w => text.includes(w));
}

const fmt = n => Number(n).toLocaleString('ar-DZ') + ' د.ج';

// --- Privacy guard -----------------------------------------------------------
// Questions probing who built the site, its technology, source, or the bot's
// own nature are deflected — we never expose that information.
const PRIVACY_TRIGGERS = [
  'من صنع', 'من صمم', 'من انشا', 'من طور', 'من برمج', 'من عمل الموقع', 'من بنى',
  'كيف صنع', 'كيف تم', 'ما هي التقنيه', 'اي تقنيه', 'التقنيات', 'لغه البرمجه',
  'الكود', 'السورس', 'source', 'code', 'خادم', 'سيرفر', 'قاعده البيانات', 'داتابيز',
  'اي ذكاء', 'ذكاء اصطناعي', 'شات', 'chatgpt', 'gpt', 'openai', 'gemini', 'claude',
  'llm', 'model', 'موديل', 'نموذج', 'من انت', 'ما انت', 'هل انت بوت', 'هل انت روبوت',
  'هل انت انسان', 'من دربك', 'من صنعك', 'اي شركه', 'من يملك', 'استضافه', 'render',
  'github', 'مصدر', 'كيف بنيت', 'api'
];

const PRIVACY_REPLY =
  'أنا المساعد الآلي لمتجر MB1_shoop، هنا لمساعدتك في المنتجات والطلبات والتوصيل فقط. ' +
  'لا يمكنني مشاركة أي تفاصيل تقنية أو داخلية عن المتجر. كيف أساعدك في تسوّقك؟ 🛍️';

// --- Main entry --------------------------------------------------------------
// ctx = { products:[], categories:[], wilayas:[], phone:'' }
function reply(message, ctx = {}) {
  const raw = String(message || '').trim();
  if (!raw) return { text: 'مرحباً بك في MB1_shoop 👋 كيف يمكنني مساعدتك؟' };
  const t = normalize(raw);
  const products = ctx.products || [];
  const categories = ctx.categories || [];
  const wilayas = ctx.wilayas || [];
  const phone = ctx.phone || '';

  // 1) Privacy first — always wins over everything else.
  if (hasAny(t, PRIVACY_TRIGGERS)) return { text: PRIVACY_REPLY };

  // 2) Greetings
  if (hasAny(t, ['سلام', 'مرحبا', 'اهلا', 'صباح', 'مساء', 'هاي', 'هلا', 'hi', 'hello'])) {
    return { text: 'أهلاً وسهلاً بك في MB1_shoop 👋 أقدر أساعدك في الأسعار، التوصيل، طريقة الطلب أو المنتجات المتوفرة. عمّاذا تبحث؟' };
  }

  // 3) Thanks
  if (hasAny(t, ['شكرا', 'شكرن', 'مشكور', 'يعطيك', 'تسلم', 'thanks', 'thank'])) {
    return { text: 'العفو 🌟 سعداء بخدمتك دائماً في MB1_shoop. إن احتجت أي شيء آخر أنا هنا.' };
  }

  // 4) Payment
  if (hasAny(t, ['دفع', 'ادفع', 'الفلوس', 'كاش', 'تسبيق', 'كيفاش نخلص', 'الخلاص', 'payment'])) {
    return { text: '💵 الدفع عند الاستلام (كاش) في جميع الولايات — تدفع فقط عندما تستلم طلبيتك. لا حاجة لأي دفع مسبق.' };
  }

  // 5) Shipping / delivery — try to detect a specific wilaya name
  if (hasAny(t, ['توصيل', 'شحن', 'ولايه', 'ولايتي', 'يوصل', 'ديليفري', 'مكتب', 'ستوب', 'كم التوصيل', 'سعر التوصيل', 'delivery'])) {
    const w = wilayas.find(x => {
      const name = normalize(x.name);
      if (t.includes(name)) return true;
      // also match when the customer prefixes the name (e.g. "للجزائر") by
      // testing the core name without a leading definite article "ال"
      const core = name.replace(/^ال/, '');
      return core.length > 2 && t.includes(core);
    });
    if (w) {
      const office = Math.max(w.shipping - 200, 200);
      return { text: `🚚 التوصيل إلى ${w.name}:\n• إلى المنزل: ${fmt(w.shipping)}\n• إلى مكتب التوصيلات: ${fmt(office)}\nالدفع عند الاستلام 💵` };
    }
    return { text: `🚚 نوصّل إلى كل الولايات (${wilayas.length} ولاية). سعر التوصيل يختلف حسب الولاية، ويمكنك اختيار التوصيل إلى المنزل أو إلى مكتب التوصيلات (أرخص بـ200 د.ج). اكتب لي اسم ولايتك لأخبرك بالسعر بالضبط.` };
  }

  // 6) How to order
  if (hasAny(t, ['كيف اطلب', 'كيفاش نطلب', 'الطلب', 'اطلب', 'اشتري', 'كيف اشتري', 'طريقه الطلب', 'order', 'how to'])) {
    return { text: '🛒 الطلب سهل جداً:\n1) اختر المنتج واضغط «أضف إلى السلة».\n2) افتح السلة واملأ اسمك ورقم هاتفك وولايتك.\n3) اختر التوصيل (منزل/مكتب) واضغط «تأكيد الطلب».\nسيصلك المنتج والدفع عند الاستلام 💵' };
  }

  // 7) Categories / what do you sell
  if (hasAny(t, ['فئات', 'اقسام', 'تصنيف', 'ايش تبيعو', 'شنو تبيعو', 'ماذا تبيعون', 'وش عندكم', 'المنتجات', 'categories'])) {
    if (categories.length) return { text: `نوفّر لك عدة أقسام:\n• ${categories.join('\n• ')}\nاكتب اسم القسم الذي يهمّك وسأعرض لك ما فيه.` };
  }

  // 7b) A category name mentioned directly → list its products
  {
    const cat = categories.find(c => t.includes(normalize(c)));
    if (cat) {
      const inCat = products.filter(p => p.category === cat).slice(0, 6);
      if (inCat.length) {
        const lines = inCat.map(p => `• ${p.name}: ${fmt(p.price)}`).join('\n');
        return { text: `منتجات قسم «${cat}»:\n${lines}\nيمكنك إضافة ما يعجبك للسلة من صفحة المتجر 🛍️` };
      }
      return { text: `قسم «${cat}» متوفر لدينا، لكن لا توجد منتجات معروضة فيه حالياً. تصفّح بقية الأقسام في صفحة المتجر.` };
    }
  }

  // 8) Price / specific product lookup
  if (hasAny(t, ['سعر', 'ثمن', 'بكم', 'كم سعر', 'بشحال', 'شحال', 'كم يكلف', 'price', 'cost'])) {
    const matches = products.filter(p => {
      const name = normalize(p.name);
      return name && (t.includes(name) || name.split(' ').some(word => word.length > 2 && t.includes(word)));
    }).slice(0, 5);
    if (matches.length) {
      const lines = matches.map(p => `• ${p.name}: ${fmt(p.price)}`).join('\n');
      return { text: `الأسعار المتوفرة:\n${lines}\n(الدفع عند الاستلام، والتوصيل حسب الولاية)` };
    }
    return { text: 'أخبرني باسم المنتج الذي تريد معرفة سعره (تيشرت، سروال، حذاء...) وسأخبرك بالسعر مباشرةً. كما يمكنك تصفّح كل الأسعار في صفحة المتجر.' };
  }

  // 9) Product name mentioned without the word "price"
  {
    const matches = products.filter(p => {
      const name = normalize(p.name);
      return name && name.split(' ').some(word => word.length > 2 && t.includes(word));
    }).slice(0, 5);
    if (matches.length) {
      const lines = matches.map(p => `• ${p.name}: ${fmt(p.price)}${p.description ? ' — ' + p.description : ''}`).join('\n');
      return { text: `إليك ما وجدته:\n${lines}\nيمكنك إضافته للسلة مباشرةً من صفحة المتجر 🛍️` };
    }
  }

  // 10) Contact / human / admin absent
  if (hasAny(t, ['رقم', 'هاتف', 'اتصال', 'واتساب', 'whatsapp', 'تواصل', 'مسؤول', 'خدمه', 'شكوي', 'مشكله', 'contact', 'phone'])) {
    return { text: `📞 يمكنك التواصل معنا مباشرةً على الرقم: ${phone}\nأو إرسال طلبك/استفسارك عبر واتساب على نفس الرقم، وسيرد عليك المسؤول في أقرب وقت.` };
  }

  // 11) Availability
  if (hasAny(t, ['متوفر', 'موجود', 'عندكم', 'في ستوك', 'stock', 'available'])) {
    return { text: 'كل المنتجات المعروضة في صفحة المتجر متوفرة للطلب حالياً ✅ إن لم تجد منتجاً معيّناً اكتب لي اسمه وسأتحقق لك.' };
  }

  // 12) Fallback — helpful, and hands off to a human when needed
  return {
    text: 'لم أفهم طلبك تماماً 🤔 يمكنني مساعدتك في:\n• الأسعار والمنتجات\n• أسعار التوصيل لولايتك\n• طريقة الطلب والدفع\n' +
          (phone ? `وإن أردت التحدث مع المسؤول مباشرةً: ${phone} (واتساب متاح).` : '')
  };
}

module.exports = { reply, normalize };
