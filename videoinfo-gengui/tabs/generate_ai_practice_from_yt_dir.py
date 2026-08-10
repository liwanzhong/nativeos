from __future__ import annotations

import json
import re
import sys
from pathlib import Path
from typing import Any


def normalize_space(text: str) -> str:
    return re.sub(r"\s+", " ", text or "").strip()


def load_json(path: Path) -> Any:
    with path.open("r", encoding="utf-8") as f:
        return json.load(f)


def extract_utterances(path: Path, max_lines: int = 40) -> list[str]:
    data = load_json(path)
    lines: list[str] = []
    for event in data.get("events", []):
        segs = event.get("segs")
        if not isinstance(segs, list):
            continue
        text = "".join(seg.get("utf8", "") for seg in segs if isinstance(seg, dict))
        text = normalize_space(text.replace("\n", " "))
        if not text:
            continue
        if text.startswith("[") and text.endswith("]"):
            continue
        if lines and text == lines[-1]:
            continue
        lines.append(text)
        if len(lines) >= max_lines:
            break
    return lines


def first_meaningful_sentence(description: str) -> str:
    cleaned = normalize_space(description.replace("\r", " ").replace("\n", " "))
    if not cleaned:
        return ""
    cleaned = re.sub(r"https?://\S+", "", cleaned)
    cleaned = normalize_space(cleaned)
    parts = re.split(r"(?<=[.!?])\s+", cleaned)
    blocked_tokens = [
        "sproutlanguage.com",
        "apple app store",
        "google play store",
        "7 days free",
        "speak with jay",
        "speak with jay-i",
        "speak with jay-i here",
        "become fluent",
        "ready to actually speak",
        "join my live learning sessions",
        "see all my videos here",
        "get the sprout app",
        "stress free",
    ]
    for part in parts:
        low = part.lower()
        if any(token in low for token in blocked_tokens):
            continue
        if len(part) >= 30:
            return part
    return parts[0] if parts else cleaned


def build_content_anchor(description: str, transcript_lines: list[str], title: str) -> str:
    meaningful_description = first_meaningful_sentence(description)
    lowered_description = meaningful_description.lower()
    if (
        "#" in meaningful_description
        or any(token in lowered_description for token in [
            "see you there",
            "prepare your questions",
            "englishvlog",
            "learnenglish",
            "comprehensibleinput",
            "real-life english",
        ])
    ):
        meaningful_description = ""
    transcript_anchor = " ".join(safe_snippet_list(transcript_lines, title)[:2])
    if meaningful_description and transcript_anchor:
        return f"{meaningful_description} {transcript_anchor}"[:320]
    if transcript_anchor:
        return transcript_anchor[:320]
    return meaningful_description or title


def clean_topic_label(title: str) -> str:
    topic = title
    replacements = [
        (r"(?i)learn english( with| while| through| for)?", ""),
        (r"(?i)comprehensible input vlog", ""),
        (r"(?i)comprehensible input", ""),
        (r"(?i)for english learners", ""),
        (r"(?i)easier than you think", ""),
        (r"(?i)all you need to know for travelling abroad", ""),
        (r"(?i)b1-b2 level", ""),
    ]
    for pattern, repl in replacements:
        topic = re.sub(pattern, repl, topic)
    topic = topic.replace("|", " ").replace("｜", " ")
    topic = topic.replace(":", " ").replace("：", " ")
    topic = normalize_space(topic)
    topic = re.sub(r"^[\-–—\s]+", "", topic)
    topic = re.sub(r"[\-–—\s]+$", "", topic)
    return topic or title


def infer_level(title: str, description: str, transcript: list[str]) -> str:
    text = f"{title} {description} {' '.join(transcript[:12])}".lower()
    if "c1" in text or "c2" in text:
        return "C1"
    if "b2" in text:
        return "B2"
    if "a2" in text:
        return "A2"
    if any(token in text for token in ["slang", "fluency", "q&a", "small talk", "hotel english"]):
        return "B2"
    if any(token in text for token in ["supermarket", "mall", "haircut", "daily routine", "christmas", "birthday"]):
        return "B1"
    return "B1"


def infer_theme(title: str, description: str, transcript: list[str]) -> str:
    text = f"{title} {description} {' '.join(transcript[:20])}".lower()
    checks = [
        ("hotel", ["hotel", "check in", "reception", "front desk", "room key"]),
        ("airport", ["airport", "boarding", "passport", "flight", "terminal", "gate"]),
        ("haircut", ["haircut", "barber", "barbershop", "trim", "fade"]),
        ("shopping", ["supermarket", "mall", "shopping", "clothes", "size", "cashier", "store"]),
        ("small_talk", ["small talk", "conversation starter", "awkward silence"]),
        ("slang", ["slang", "british boys", "phrase", "expression"]),
        ("learning_advice", ["school", "fluent", "fluency", "good habits", "bad habits", "be good at english", "method"]),
        ("holiday", ["christmas", "birthday", "gift", "celebration"]),
        ("home_life", ["moving house", "clean my house", "daily routine", "start my day", "house", "cook", "plant", "coffee", "pasta"]),
        ("travel_city", ["singapore", "busan", "seoul", "london", "travel", "trip", "city", "countryside", "bike", "night", "beach", "mountain"]),
        ("qa_reflection", ["q&a", "subscribers", "teaching english"]),
    ]
    for theme, keywords in checks:
        if any(keyword in text for keyword in keywords):
            return theme
    return "lifestyle"


def safe_snippet(lines: list[str], fallback: str) -> str:
    for line in lines:
        cleaned = normalize_space(line)
        if len(cleaned) >= 12:
            return cleaned[:180]
    return fallback


def safe_snippet_list(lines: list[str], fallback: str) -> list[str]:
    picked: list[str] = []
    for line in lines:
        cleaned = normalize_space(line)
        if len(cleaned) < 12:
            continue
        picked.append(cleaned[:160])
        if len(picked) >= 3:
            break
    if not picked:
        picked.append(fallback)
    return picked


def build_theme_cards(theme: str, topic: str) -> list[dict[str, Any]]:
    cards_by_theme: dict[str, list[dict[str, Any]]] = {
        "hotel": [
            {"title": "办理入住", "icon": "🏨", "category": "酒店出行", "npcEmoji": "🛎️", "npcName": "Hotel Clerk", "npcStatus": "正在核对预订信息", "desc": f"Check into a hotel smoothly and confirm the key details for your stay around {topic}.", "descZh": f"围绕「{topic}」自然办理入住并确认住宿细节。", "userInitiates": False, "openingLine": "Good evening. Welcome in. Do you already have a reservation?", "openingLineZh": "晚上好，欢迎光临。请问你已经有预订了吗？"},
            {"title": "房间需求", "icon": "🛏️", "category": "酒店出行", "npcEmoji": "🏨", "npcName": "Receptionist", "npcStatus": "等你说明住宿需求", "desc": f"Ask about room type, breakfast, or a small problem connected to {topic}.", "descZh": f"围绕「{topic}」询问房型、早餐或住宿问题。", "userInitiates": True, "environmentalCue": f"你刚到酒店，想把和「{topic}」相关的需求说清楚，比如房型、早餐或入住细节。前台正在忙别的事，需要你先自然开口。", "environmentalCueEn": f"You have just arrived at the hotel and want to explain a need related to {topic}, such as the room, breakfast, or check-in details. The receptionist is busy, so you need to start naturally."},
            {"title": "旅途求助", "icon": "🧳", "category": "酒店出行", "npcEmoji": "🙂", "npcName": "Travel Assistant", "npcStatus": "准备给你旅行建议", "desc": f"Continue the hotel conversation and ask for practical local help after {topic}.", "descZh": f"围绕「{topic}」继续追问旅途中的实际帮助。", "userInitiates": False, "openingLine": "Now that you're checked in, what else do you need help with for your trip?", "openingLineZh": "现在你已经办好入住了，旅途中还有什么需要帮忙的吗？"},
        ],
        "airport": [
            {"title": "登机求助", "icon": "✈️", "category": "机场出行", "npcEmoji": "🛄", "npcName": "Airport Staff", "npcStatus": "正在处理旅客问题", "desc": f"Handle an airport conversation naturally and ask for help related to {topic}.", "descZh": f"围绕「{topic}」自然处理机场求助对话。", "userInitiates": False, "openingLine": "Hi there, what seems to be the issue with your flight today?", "openingLineZh": "你好，请问你今天的航班遇到了什么问题？"},
            {"title": "路线确认", "icon": "🛫", "category": "机场出行", "npcEmoji": "👮", "npcName": "Airport Guide", "npcStatus": "正在看指示牌", "desc": f"Ask for directions, timing, or procedures at the airport after watching {topic}.", "descZh": f"看完「{topic}」后，练习询问机场路线和流程。", "userInitiates": True, "environmentalCue": f"你在机场里有点赶时间，想确认和「{topic}」有关的登机、安检或路线信息。工作人员就在附近，但需要你先开口。", "environmentalCueEn": f"You are in a hurry at the airport and want to confirm boarding, security, or directions related to {topic}. A staff member is nearby, but you need to speak first."},
            {"title": "旅途闲聊", "icon": "🌍", "category": "机场出行", "npcEmoji": "🙂", "npcName": "Fellow Traveller", "npcStatus": "刚聊起旅途安排", "desc": f"Turn the airport topic into a casual travel conversation about {topic}.", "descZh": f"把「{topic}」延展成轻松自然的旅行闲聊。", "userInitiates": False, "openingLine": "Travelling can be stressful. How has your day been so far?", "openingLineZh": "旅行有时候挺累的。你今天到目前为止怎么样？"},
        ],
        "haircut": [
            {"title": "理发需求", "icon": "💇", "category": "理发沟通", "npcEmoji": "✂️", "npcName": "Barber", "npcStatus": "正在确认发型需求", "desc": f"Explain clearly what kind of haircut or style you want in the situation of {topic}.", "descZh": f"围绕「{topic}」清楚表达你的理发需求。", "userInitiates": False, "openingLine": "Welcome in. What are we doing with your hair today?", "openingLineZh": "欢迎光临。你今天想怎么剪头发？"},
            {"title": "造型偏好", "icon": "🪞", "category": "理发沟通", "npcEmoji": "💈", "npcName": "Stylist", "npcStatus": "等你描述偏好", "desc": f"Describe length, style, and what you do not want when discussing {topic}.", "descZh": f"围绕「{topic}」说明长度、风格和不想要的效果。", "userInitiates": True, "environmentalCue": f"你坐到镜子前，想根据「{topic}」里的场景把自己的要求说得更自然。理发师已经准备好了，但要你先描述。", "environmentalCueEn": f"You are sitting in front of the mirror and want to describe your haircut naturally, using the kind of language from {topic}. The barber is ready, but you need to explain first."},
            {"title": "服务反馈", "icon": "🙂", "category": "理发沟通", "npcEmoji": "💬", "npcName": "Barber", "npcStatus": "想确认你是否满意", "desc": f"React naturally to the result and ask for a small adjustment after {topic}.", "descZh": f"围绕「{topic}」自然反馈效果并提出微调。", "userInitiates": False, "openingLine": "Take a look. How does that feel so far?", "openingLineZh": "你看一下，现在感觉怎么样？"},
        ],
        "shopping": [
            {"title": "选购商品", "icon": "🛍️", "category": "购物消费", "npcEmoji": "🧑", "npcName": "Shop Assistant", "npcStatus": "正在整理货架", "desc": f"Ask about products, choices, or recommendations linked to {topic}.", "descZh": f"围绕「{topic}」练习询问商品选择和推荐。", "userInitiates": False, "openingLine": "Hi! Are you looking for anything in particular today?", "openingLineZh": "你好！你今天有特别想找的东西吗？"},
            {"title": "询问细节", "icon": "🛒", "category": "购物消费", "npcEmoji": "🏬", "npcName": "Store Clerk", "npcStatus": "等你继续提问", "desc": f"Ask about size, price, ingredients, or availability in the context of {topic}.", "descZh": f"围绕「{topic}」追问尺寸、价格或库存细节。", "userInitiates": True, "environmentalCue": f"你在店里看到几个和「{topic}」相关的选择，想进一步问清楚尺寸、价格或适不适合自己。店员就在附近，需要你先开口。", "environmentalCueEn": f"You can see several options related to {topic} and want to ask about the size, price, or whether something suits you. A shop assistant is nearby, and you need to start."},
            {"title": "结账闲聊", "icon": "💳", "category": "购物消费", "npcEmoji": "🙂", "npcName": "Cashier", "npcStatus": "正在帮你结账", "desc": f"Turn the shopping topic into a short, natural checkout conversation after {topic}.", "descZh": f"把「{topic}」延展成自然的结账小对话。", "userInitiates": False, "openingLine": "Did you find everything you needed today?", "openingLineZh": "你今天想买的都找到了吗？"},
        ],
        "small_talk": [
            {"title": "轻松寒暄", "icon": "💬", "category": "社交闲聊", "npcEmoji": "🙂", "npcName": "Jay", "npcStatus": "想和你轻松聊两句", "desc": f"Practise starting and maintaining relaxed small talk connected to {topic}.", "descZh": f"围绕「{topic}」练习自然开启并维持闲聊。", "userInitiates": False, "openingLine": "Lovely day, isn't it? How's your day been going?", "openingLineZh": "今天天气不错，对吧？你今天过得怎么样？"},
            {"title": "接话延展", "icon": "🗣️", "category": "社交闲聊", "npcEmoji": "👋", "npcName": "New Friend", "npcStatus": "给你留出接话空间", "desc": f"Respond naturally and add your own detail when the topic is {topic}.", "descZh": f"围绕「{topic}」练习接话并自然补充细节。", "userInitiates": True, "environmentalCue": f"对方看起来挺友好，气氛也不尴尬。你想借着「{topic}」里的表达，自然把闲聊继续下去，需要你先接话。", "environmentalCueEn": f"The other person seems friendly and the mood is easy. You want to use the kind of language from {topic} to keep the conversation going, and you need to speak first."},
            {"title": "观点追问", "icon": "🙂", "category": "社交闲聊", "npcEmoji": "🤝", "npcName": "Conversation Partner", "npcStatus": "正在顺着话题往下聊", "desc": f"Move from casual small talk into a slightly deeper opinion exchange around {topic}.", "descZh": f"把「{topic}」从寒暄自然延展到观点交流。", "userInitiates": False, "openingLine": "People often stop at small talk, but what's your real opinion on it?", "openingLineZh": "很多人闲聊只聊表面，那你真正的看法是什么？"},
        ],
        "slang": [
            {"title": "表达解释", "icon": "🇬🇧", "category": "口语表达", "npcEmoji": "😄", "npcName": "British Friend", "npcStatus": "正在解释口语说法", "desc": f"Discuss the meaning and real-life use of informal English from {topic}.", "descZh": f"围绕「{topic}」聊真实口语表达的意思和用法。", "userInitiates": False, "openingLine": "That phrase sounds natural, but when would you actually use it?", "openingLineZh": "这个说法听起来很地道，但你什么时候真的会这么说？"},
            {"title": "情境使用", "icon": "🗣️", "category": "口语表达", "npcEmoji": "🙂", "npcName": "Language Buddy", "npcStatus": "想听你试着使用表达", "desc": f"Try using one of the expressions from {topic} in your own situation.", "descZh": f"围绕「{topic}」试着把表达迁移到你自己的情境里。", "userInitiates": True, "environmentalCue": f"你刚学到几个和「{topic}」有关的地道表达，现在想试着放进自己的情境里。对方愿意帮你纠正，但需要你先开口。", "environmentalCueEn": f"You have just learned a few natural expressions related to {topic} and want to use them in your own situation. The other person is happy to help, but you need to start."},
            {"title": "语气比较", "icon": "🎯", "category": "口语表达", "npcEmoji": "🤔", "npcName": "Coach", "npcStatus": "准备和你比较说法差异", "desc": f"Compare neutral English with more natural spoken English inspired by {topic}.", "descZh": f"围绕「{topic}」比较中性表达和更自然的口语表达。", "userInitiates": False, "openingLine": "How would you say that in a more natural, less textbook way?", "openingLineZh": "如果想说得更自然、更不像课本，你会怎么表达？"},
        ],
        "learning_advice": [
            {"title": "学习方法", "icon": "📘", "category": "英语方法", "npcEmoji": "🧠", "npcName": "Jay", "npcStatus": "正在分享学习观点", "desc": f"Discuss the learning ideas in {topic} and explain what works for you personally.", "descZh": f"围绕「{topic}」聊英语学习方法和你的真实体验。", "userInitiates": False, "openingLine": "A lot of learners work hard, but not always in the right way. What do you think?", "openingLineZh": "很多学习者很努力，但不一定方向对。你怎么看？"},
            {"title": "习惯改变", "icon": "🌱", "category": "英语方法", "npcEmoji": "🙂", "npcName": "Study Partner", "npcStatus": "等你分享学习习惯", "desc": f"Talk about one habit you want to change after watching {topic}.", "descZh": f"围绕「{topic}」聊一个你想改变的学习习惯。", "userInitiates": True, "environmentalCue": f"看完「{topic}」后，你开始反思自己的英语学习习惯。你想自然说出自己现在的问题和准备怎么改，需要你先开口。", "environmentalCueEn": f"After watching {topic}, you start reflecting on your own English learning habits. You want to explain what is not working and how you plan to change it, so you need to speak first."},
            {"title": "观点辩论", "icon": "💡", "category": "英语方法", "npcEmoji": "🤝", "npcName": "Coach", "npcStatus": "准备追问你的理由", "desc": f"Defend or challenge one opinion from {topic} with practical examples.", "descZh": f"围绕「{topic}」用实际例子说明你赞同或不赞同的观点。", "userInitiates": False, "openingLine": "Interesting idea. But would that approach work for every learner?", "openingLineZh": "这个观点挺有意思。但它真的适合所有学习者吗？"},
        ],
        "holiday": [
            {"title": "节日准备", "icon": "🎄", "category": "节日生活", "npcEmoji": "🎁", "npcName": "Friend", "npcStatus": "正在准备节日安排", "desc": f"Talk about your plans, mood, and little details around {topic}.", "descZh": f"围绕「{topic}」聊节日安排、心情和小细节。", "userInitiates": False, "openingLine": "So, what are you doing for the celebration this year?", "openingLineZh": "所以，你今年准备怎么过这个节日？"},
            {"title": "购物安排", "icon": "🛍️", "category": "节日生活", "npcEmoji": "🙂", "npcName": "Shopping Buddy", "npcStatus": "想和你一起安排采购", "desc": f"Plan gifts, food, or decorations naturally in a conversation based on {topic}.", "descZh": f"围绕「{topic}」自然聊礼物、食物或布置安排。", "userInitiates": True, "environmentalCue": f"你在准备和「{topic}」有关的节日事项，脑子里有很多零碎安排。朋友就在旁边，可以一起讨论，但需要你先把话题接起来。", "environmentalCueEn": f"You are preparing things related to {topic} and have a lot of little details in mind. A friend is nearby and happy to chat, but you need to start the conversation."},
            {"title": "感受分享", "icon": "✨", "category": "节日生活", "npcEmoji": "😊", "npcName": "Close Friend", "npcStatus": "想听你分享感受", "desc": f"Move beyond the practical side and share your personal feelings about {topic}.", "descZh": f"围绕「{topic}」从安排延展到个人感受表达。", "userInitiates": False, "openingLine": "These moments can feel really special. What do you enjoy most about it?", "openingLineZh": "这种时刻往往挺特别的。你最喜欢的部分是什么？"},
        ],
        "home_life": [
            {"title": "日常安排", "icon": "🏡", "category": "日常生活", "npcEmoji": "🙂", "npcName": "Friend", "npcStatus": "想听你聊日常", "desc": f"Continue a natural conversation about the everyday routines and moments in {topic}.", "descZh": f"围绕「{topic}」继续聊真实日常和生活细节。", "userInitiates": False, "openingLine": "That looked like such a normal but satisfying part of the day. What was going through your mind?", "openingLineZh": "那一段看起来很日常，但又挺让人满足。当时你在想什么？"},
            {"title": "一起做事", "icon": "☕", "category": "日常生活", "npcEmoji": "🤝", "npcName": "Roommate", "npcStatus": "准备和你一起安排事情", "desc": f"Plan or talk through a simple activity connected to {topic}, like cleaning, cooking, or going out.", "descZh": f"围绕「{topic}」聊做饭、整理或出门等实际安排。", "userInitiates": True, "environmentalCue": f"你想把「{topic}」里的生活场景迁移到自己的表达里，比如做饭、整理、喝咖啡或安排一天。对方就在身边，但需要你先开口。", "environmentalCueEn": f"You want to bring the everyday language from {topic} into your own speaking, whether that means cooking, tidying up, grabbing coffee, or planning the day. The other person is there, but you need to start."},
            {"title": "生活偏好", "icon": "🌿", "category": "日常生活", "npcEmoji": "😊", "npcName": "Close Friend", "npcStatus": "想知道你的偏好", "desc": f"Use the vlog topic to compare personal preferences, habits, and lifestyle choices.", "descZh": f"围绕「{topic}」比较彼此的偏好、习惯和生活方式。", "userInitiates": False, "openingLine": "Everyone has their own way of doing everyday things. What's yours like?", "openingLineZh": "每个人处理日常生活的方式都不一样。你平时是怎么做的？"},
        ],
        "travel_city": [
            {"title": "城市见闻", "icon": "🧳", "category": "旅行城市", "npcEmoji": "🙂", "npcName": "Travel Friend", "npcStatus": "刚和你聊起旅行见闻", "desc": f"Talk about what stood out to you in {topic} and describe the atmosphere naturally.", "descZh": f"围绕「{topic}」聊最有印象的见闻和现场氛围。", "userInitiates": False, "openingLine": "That place looked amazing. What stood out to you most?", "openingLineZh": "那个地方看起来很棒。最让你印象深刻的是什么？"},
            {"title": "路线求助", "icon": "🗺️", "category": "旅行城市", "npcEmoji": "🚶", "npcName": "Local", "npcStatus": "正在听你描述行程", "desc": f"Ask for practical help or local recommendations connected to {topic}.", "descZh": f"围绕「{topic}」练习询问路线、安排或本地推荐。", "userInitiates": True, "environmentalCue": f"你正在一个和「{topic}」相关的城市或旅行场景里，想问路线、交通或推荐。当地人就在附近，需要你先自然开口。", "environmentalCueEn": f"You are in a city or travel situation related to {topic} and want to ask about directions, transport, or recommendations. A local person is nearby, and you need to start."},
            {"title": "行程分享", "icon": "🌆", "category": "旅行城市", "npcEmoji": "😊", "npcName": "Travel Partner", "npcStatus": "准备继续聊行程体验", "desc": f"Move from description into a more personal travel conversation inspired by {topic}.", "descZh": f"把「{topic}」从景点描述延展到更个人化的旅行体验。", "userInitiates": False, "openingLine": "Trips are never just about the place. How did the whole experience feel to you?", "openingLineZh": "旅行不只是看地点而已。整个体验对你来说是什么感觉？"},
        ],
        "qa_reflection": [
            {"title": "经历分享", "icon": "🎤", "category": "内容访谈", "npcEmoji": "🙂", "npcName": "Host", "npcStatus": "正在请你展开回答", "desc": f"Answer a personal question in a natural, reflective way based on {topic}.", "descZh": f"围绕「{topic}」自然回答带有个人经历的问题。", "userInitiates": False, "openingLine": "That's an interesting story. How did things develop from there?", "openingLineZh": "这个经历挺有意思的。后来事情是怎么发展的？"},
            {"title": "追问细节", "icon": "❓", "category": "内容访谈", "npcEmoji": "🤔", "npcName": "Interviewer", "npcStatus": "等你补充细节", "desc": f"Give fuller details and examples when discussing {topic}.", "descZh": f"围绕「{topic}」补充更完整的细节和例子。", "userInitiates": True, "environmentalCue": f"你刚被问到一个和「{topic}」有关的问题，脑子里有答案，但想组织得更自然一点。对方在等你继续说，需要你先接上。", "environmentalCueEn": f"You have just been asked something related to {topic}. You know what you want to say, but you want to organize it more naturally, so you need to continue first."},
            {"title": "观点延展", "icon": "💡", "category": "内容访谈", "npcEmoji": "🤝", "npcName": "Host", "npcStatus": "准备追问你的看法", "desc": f"Turn a factual answer into a more thoughtful opinion exchange around {topic}.", "descZh": f"围绕「{topic}」把事实回答延展成更深入的观点交流。", "userInitiates": False, "openingLine": "That explains what happened, but what did you learn from it?", "openingLineZh": "这说明了发生了什么，但你从中学到了什么？"},
        ],
        "lifestyle": [
            {"title": "继续聊聊", "icon": "💬", "category": "生活表达", "npcEmoji": "🙂", "npcName": "Conversation Partner", "npcStatus": "想继续顺着视频往下聊", "desc": f"Continue speaking naturally about the real-life topic in {topic}.", "descZh": f"围绕「{topic}」继续自然开口，把视频话题延展下去。", "userInitiates": False, "openingLine": "That was interesting. How would you talk about that in your own life?", "openingLineZh": "刚才那段挺有意思的。换成你的生活，你会怎么聊？"},
            {"title": "个人经历", "icon": "🌱", "category": "生活表达", "npcEmoji": "😊", "npcName": "Friend", "npcStatus": "愿意听你分享", "desc": f"Use the topic of {topic} to share your own experience and preferences.", "descZh": f"围绕「{topic}」分享你自己的经历和偏好。", "userInitiates": True, "environmentalCue": f"你刚看完和「{topic}」有关的视频，脑子里也想起了自己的类似经历。朋友愿意听你继续说，但需要你先开口。", "environmentalCueEn": f"You have just watched a video about {topic} and it reminds you of your own experience. A friend is happy to listen, but you need to start the conversation."},
            {"title": "想法交流", "icon": "✨", "category": "生活表达", "npcEmoji": "🤝", "npcName": "Buddy", "npcStatus": "准备和你交换看法", "desc": f"Move from description into a more thoughtful exchange of ideas related to {topic}.", "descZh": f"围绕「{topic}」从描述过渡到更深入的想法交流。", "userInitiates": False, "openingLine": "People can see the same situation differently. What's your take on it?", "openingLineZh": "同一件事每个人看法都不一样。你的理解是什么？"},
        ],
    }
    return cards_by_theme.get(theme, cards_by_theme["lifestyle"])


def slug_from_stem(stem: str) -> str:
    lead = re.match(r"^(\d+)", stem)
    prefix = lead.group(1) if lead else "video"
    return f"sprout-{prefix}"


def build_items(stem: str, info: dict[str, Any], transcript_lines: list[str]) -> list[dict[str, Any]]:
    title = normalize_space(str(info.get("title") or stem))
    raw_description = str(info.get("description") or "")
    description = first_meaningful_sentence(raw_description)
    topic = clean_topic_label(title)
    level = infer_level(title, description, transcript_lines)
    theme = infer_theme(title, description, transcript_lines)
    cards = build_theme_cards(theme, topic)
    transcript_anchors = safe_snippet_list(transcript_lines, title)
    content_anchor = build_content_anchor(raw_description, transcript_lines, title)
    stem_slug = slug_from_stem(stem)
    items: list[dict[str, Any]] = []
    for index, card in enumerate(cards, start=1):
        npc_prompt = (
            f"You are {card['npcName']}, a friendly English conversation partner. "
            f"The learner just watched a video titled \"{title}\". "
            f"Keep the conversation grounded in this topic: {topic}. "
            f"Useful context from the video: {content_anchor}. "
            f"Transcript anchors: {' | '.join(transcript_anchors)}. "
            f"Help the learner continue the same content naturally at {level} level, with practical follow-up questions and room for personal experience."
        )
        item = {
            "id": f"{stem_slug}__ai__{index}",
            "icon": card["icon"],
            "category": card["category"],
            "level": level,
            "title": card["title"],
            "desc": card["desc"],
            "descZh": card["descZh"],
            "npcEmoji": card["npcEmoji"],
            "npcName": card["npcName"],
            "npcStatus": card["npcStatus"],
            "userInitiates": card["userInitiates"],
            "openingLine": None if card["userInitiates"] else card.get("openingLine"),
            "openingLineZh": None if card["userInitiates"] else card.get("openingLineZh"),
            "environmentalCue": card.get("environmentalCue") if card["userInitiates"] else None,
            "environmentalCueEn": card.get("environmentalCueEn") if card["userInitiates"] else None,
            "npcSystemPrompt": npc_prompt,
        }
        items.append(item)
    return items


def find_video_sets(target_dir: Path) -> list[tuple[str, Path, Path]]:
    info_files = {p.name[:-10]: p for p in target_dir.glob("*.info.json")}
    subtitle_files = {p.name[:-9]: p for p in target_dir.glob("*.json3")}
    video_stems = set()
    for ext in ("*.webm", "*.mp4", "*.mkv"):
        for p in target_dir.glob(ext):
            video_stems.add(p.stem)
    stems = sorted(set(info_files) & set(subtitle_files) & video_stems)
    return [(stem, info_files[stem], subtitle_files[stem]) for stem in stems]


def generate_for_dir(target_dir: Path) -> list[Path]:
    created: list[Path] = []
    for stem, info_path, subtitle_path in find_video_sets(target_dir):
        info = load_json(info_path)
        transcript_lines = extract_utterances(subtitle_path)
        items = build_items(stem, info, transcript_lines)
        output_path = target_dir / f"{stem}.ai-practice.json"
        payload = {
            "sourceVideo": stem,
            "videoTitle": info.get("title") or stem,
            "items": items,
        }
        with output_path.open("w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        created.append(output_path)
    return created


def main() -> int:
    if len(sys.argv) < 2:
        print("Usage: python generate_ai_practice_from_yt_dir.py <target_dir>")
        return 1
    target_dir = Path(sys.argv[1])
    if not target_dir.exists() or not target_dir.is_dir():
        print(f"Invalid directory: {target_dir}")
        return 1
    created = generate_for_dir(target_dir)
    print(f"Generated {len(created)} ai-practice files.")
    for path in created:
        print(path.name)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
