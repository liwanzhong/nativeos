"""Qwen API client (OpenAI-compatible) for video analysis and AI practice generation."""
from __future__ import annotations

import json
import re
import socket
import time
from pathlib import Path
from typing import Any

import urllib.request
import urllib.error

from tabs.runtime_support import load_json_config, save_json_config

TRAVEL_KEYWORDS = ['ticket', 'station', 'train', 'airport', 'flight', 'subway', 'metro', 'platform', 'rail', 'gate', '旅行', '交通', '地铁', '高铁', '机场', '车站', '火车']
ORDER_KEYWORDS = ['order', 'drink', 'coffee', 'milk', 'size', 'menu', '点单', '咖啡', '奶', '饮料', '餐']
SUPPORT_KEYWORDS = ['doctor', 'symptom', 'outage', 'invoice', 'payment', 'server', 'finance', '医生', '付款', '账单', '故障', '宕机']
REQUEST_TIMEOUT_SECONDS = 180
REQUEST_MAX_RETRIES = 2


def load_ai_config() -> dict[str, str]:
    data = load_json_config()
    return data.get('ai', {})


def save_ai_config(cfg: dict[str, str]) -> None:
    save_json_config({'ai': cfg})


def _call_qwen(
    system_prompt: str,
    user_prompt: str,
    cfg: dict[str, str] | None = None,
    *,
    max_tokens: int | None = None,
    json_object: bool = False,
) -> str:
    if cfg is None:
        cfg = load_ai_config()
    base_url = cfg.get('base_url', '').rstrip('/')
    api_key = cfg.get('api_key', '')
    model = cfg.get('model', 'qwen-plus')
    if not base_url or not api_key:
        raise ValueError('AI API 未配置，请在"扫描 & 生成"标签页的 AI 设置中填写 Base URL 和 API Key。')

    url = f'{base_url}/chat/completions'
    payload = json.dumps({
        'model': model,
        'messages': [
            {'role': 'system', 'content': system_prompt},
            {'role': 'user', 'content': user_prompt},
        ],
        'temperature': 0.7,
        'max_tokens': max_tokens,
        'response_format': {'type': 'json_object'} if json_object else None,
    }).encode('utf-8')

    req = urllib.request.Request(url, data=payload, headers={
        'Content-Type': 'application/json',
        'Authorization': f'Bearer {api_key}',
    })
    last_exc: Exception | None = None
    for attempt in range(REQUEST_MAX_RETRIES + 1):
        try:
            with urllib.request.urlopen(req, timeout=REQUEST_TIMEOUT_SECONDS) as resp:
                body = json.loads(resp.read().decode('utf-8'))
            break
        except urllib.error.HTTPError as exc:
            raise RuntimeError(f'AI API 返回 HTTP {exc.code}: {exc.read().decode("utf-8", errors="replace")}') from exc
        except Exception as exc:
            last_exc = exc
            is_timeout = isinstance(exc, (TimeoutError, socket.timeout)) or 'timed out' in str(exc).lower()
            if not is_timeout or attempt >= REQUEST_MAX_RETRIES:
                if is_timeout:
                    raise RuntimeError(f'AI API 请求超时（{REQUEST_TIMEOUT_SECONDS}s，已重试 {attempt} 次）：{exc}') from exc
                raise
            time.sleep(attempt + 1)
    if last_exc is not None and 'body' not in locals():
        raise RuntimeError(f'AI API 请求失败：{last_exc}') from last_exc

    content = body.get('choices', [{}])[0].get('message', {}).get('content', '')
    if not content:
        raise RuntimeError('AI API 返回了空内容')
    return content


def _extract_json(text: str) -> Any:
    """Extract JSON from markdown code fences or raw text."""
    m = re.search(r'```(?:json)?\s*\n?(.*?)```', text, re.DOTALL)
    raw = m.group(1).strip() if m else text.strip()
    return json.loads(raw)


def _unique_non_empty(items: list[str | None]) -> list[str]:
    seen: set[str] = set()
    result: list[str] = []
    for item in items:
        value = (item or '').strip()
        if not value or value in seen:
            continue
        seen.add(value)
        result.append(value)
    return result


def _to_search_text(seed: dict[str, Any]) -> str:
    return ' '.join([
        str(seed.get('title') or ''),
        str(seed.get('desc') or ''),
        str(seed.get('category') or ''),
        str(seed.get('npcSystemPrompt') or ''),
        str(seed.get('openingLine') or ''),
        str(seed.get('environmentalCue') or ''),
        str(seed.get('environmentalCueEn') or ''),
    ]).lower()


def _infer_required_slots(seed: dict[str, Any]) -> list[dict[str, Any]]:
    text = _to_search_text(seed)
    if any(keyword in text for keyword in TRAVEL_KEYWORDS):
        return [
            {'key': 'destination', 'label': 'Destination', 'description': 'Where the learner wants to go or which station/service they need.', 'required': True},
            {'key': 'ticketType', 'label': 'Ticket Type', 'description': 'Whether they need a single, return, one-way, or other ticket type.', 'required': True},
            {'key': 'followUpNeed', 'label': 'Follow-up Need', 'description': 'Any adjacent need such as platform, exit, transfer, or signage help.', 'required': False},
        ]
    if any(keyword in text for keyword in ORDER_KEYWORDS):
        return [
            {'key': 'item', 'label': 'Item', 'description': 'The main thing the learner wants to order or request.', 'required': True},
            {'key': 'customization', 'label': 'Customization', 'description': 'Any substitution, quantity, size, or preference.', 'required': False},
            {'key': 'paymentOrPickup', 'label': 'Payment or Pickup', 'description': 'Any follow-up need related to paying, pickup, or timing.', 'required': False},
        ]
    if any(keyword in text for keyword in SUPPORT_KEYWORDS):
        return [
            {'key': 'coreIssue', 'label': 'Core Issue', 'description': 'The main problem the learner is trying to explain or solve.', 'required': True},
            {'key': 'constraint', 'label': 'Constraint', 'description': 'Relevant urgency, limitation, or business/medical detail.', 'required': False},
            {'key': 'desiredOutcome', 'label': 'Desired Outcome', 'description': 'What concrete help or resolution the learner wants.', 'required': True},
        ]
    return [
        {'key': 'request', 'label': 'Request', 'description': 'The learner’s main request in this scenario.', 'required': True},
        {'key': 'constraint', 'label': 'Constraint', 'description': 'Any important preference, limit, or extra detail.', 'required': False},
    ]


def _infer_allowed_topic_extensions(seed: dict[str, Any]) -> list[str]:
    text = _to_search_text(seed)
    if any(keyword in text for keyword in TRAVEL_KEYWORDS):
        return _unique_non_empty([
            'clarifying destination or route',
            'single vs return ticket decisions',
            'payment or machine usage questions',
            'adjacent wayfinding such as exits, transfers, or platform signs after confirming the shift',
        ])
    if any(keyword in text for keyword in ORDER_KEYWORDS):
        return _unique_non_empty([
            'size or quantity adjustments',
            'ingredient substitutions',
            'price or payment follow-up',
            'pickup timing or order confirmation',
        ])
    if any(keyword in text for keyword in SUPPORT_KEYWORDS):
        return _unique_non_empty([
            'clarifying the issue',
            'explaining constraints or urgency',
            'asking about next steps or options',
            'confirming the requested resolution',
        ])
    return _unique_non_empty([
        'clarifying the learner request',
        'negotiating realistic alternatives',
        'asking for the next missing detail',
    ])


def _infer_out_of_scope_topics(seed: dict[str, Any]) -> list[str]:
    text = _to_search_text(seed)
    if any(keyword in text for keyword in TRAVEL_KEYWORDS):
        return _unique_non_empty([
            'unrelated social chat that abandons the transport task',
            'switching to a completely different service without confirming the change',
        ])
    if any(keyword in text for keyword in ORDER_KEYWORDS):
        return _unique_non_empty([
            'unrelated travel or workplace problem-solving',
            'switching to a different business entirely without confirmation',
        ])
    return _unique_non_empty([
        'topics unrelated to the current real-world task',
        'abandoning the current request without confirming a new one',
    ])


def derive_task_contract(seed: dict[str, Any], partial: dict[str, Any] | None = None) -> dict[str, Any]:
    partial = partial or {}
    required_slots = [slot for slot in (partial.get('requiredSlots') or []) if isinstance(slot, dict) and slot.get('key')]
    if not required_slots:
        required_slots = _infer_required_slots(seed)
    scene_frame = ' '.join(_unique_non_empty([
        str(seed.get('openingLine') or ''),
        str(seed.get('environmentalCueEn') or ''),
        str(seed.get('environmentalCue') or ''),
        str(seed.get('npcStatus') or ''),
        f"{seed.get('category')} scenario" if seed.get('category') else '',
    ]))
    completion_criteria = partial.get('completionCriteria') or []
    if not completion_criteria:
        required_labels = [f"Confirm {str(slot.get('label') or slot.get('key')).lower()} before wrapping up." for slot in required_slots if slot.get('required')]
        completion_criteria = [
            ' '.join(required_labels).strip(),
            'The learner should leave with a clear next step or concrete answer.',
        ]
    return {
        'objective': str(partial.get('objective') or seed.get('desc') or f"Handle the scenario '{seed.get('title', 'Untitled')}' naturally and help the learner complete the real-world task.").strip(),
        'learnerGoal': str(partial.get('learnerGoal') or seed.get('desc') or f"The learner wants to complete the task in the scenario '{seed.get('title', 'Untitled')}'.").strip(),
        'npcRole': str(partial.get('npcRole') or seed.get('npcSystemPrompt') or f"{seed.get('npcName', 'The NPC')} should stay in role and guide the interaction within the scenario.").strip(),
        'sceneFrame': scene_frame,
        'initialStage': str(partial.get('initialStage') or (f"collect_{required_slots[0]['key']}" if required_slots else 'clarify_request')).strip(),
        'requiredSlots': required_slots,
        'allowedTopicExtensions': _unique_non_empty(list(partial.get('allowedTopicExtensions') or [])) or _infer_allowed_topic_extensions(seed),
        'outOfScopeTopics': _unique_non_empty(list(partial.get('outOfScopeTopics') or [])) or _infer_out_of_scope_topics(seed),
        'completionCriteria': _unique_non_empty([str(item) for item in completion_criteria if str(item).strip()]),
    }


# ---------------------------------------------------------------------------
# 1) AI 陪练场景卡片生成
# ---------------------------------------------------------------------------

def _build_practice_prompt(level: str, count: int, npc_first_count: int, user_first_count: int) -> str:
    """Build the system prompt for AI practice card generation, aligned with rn-app scenario-generator.ts."""
    return f"""\
You are NativeOS, an immersive English learning scenario designer.
Given a video's title, description, and transcript excerpts, generate exactly {count} real-life English practice scenario cards.

Each card is a conversation scenario where a Chinese learner practises spoken English around topics and scenes extracted from the video.

Learner CEFR level: {level}

## Dual-Initiation Engine
Every scenario belongs to one of two tracks. The track determines exactly which fields are filled.

### Track A — npc_first ({npc_first_count} scenarios): NPC speaks first
When: The NPC naturally initiates (e.g. shopkeeper greets a customer, receptionist asks how to help).
Field rules:
- userInitiates = false
- openingLine = NPC's first English sentence (grammatically correct, in-character, appropriate to NPC's role)
- openingLineZh = accurate Chinese translation of openingLine
- environmentalCue = null  ← MUST be null
- environmentalCueEn = null  ← MUST be null

### Track B — user_first ({user_first_count} scenarios): User speaks first
When: The NPC is busy/occupied — user must break the silence to initiate.
Field rules:
- userInitiates = true
- openingLine = null  ← MUST be null
- openingLineZh = null  ← MUST be null
- environmentalCue = Chinese-only narration (普通话, 2-3 sentences): describe the scene vividly, what the NPC is doing, and give the user a subtle hint about how to start. NEVER write English here.
- environmentalCueEn = English-only narration: same content as environmentalCue translated to English, CEFR-appropriate for {level}. NEVER write Chinese here.

### npcSystemPrompt (both tracks)
1-2 English sentences that:
1. Clearly state the NPC's role (e.g. "You are a stationery shop assistant.")
2. Clearly state the learner's role (e.g. "The learner is a customer who wants to buy tape.")
3. Add scenario-appropriate friction (e.g. "You are slightly busy and ask clarifying questions before helping.")
IMPORTANT: Role assignments MUST be logically consistent with the scenario title and desc.

### taskContract (both tracks)
Return a structured conversation contract object that makes the scenario executable across multiple turns:
- objective: one sentence describing the real-world task outcome
- learnerGoal: what the learner is trying to achieve right now
- npcRole: the NPC's responsibility boundary in this scenario
- sceneFrame: the immediate situation or context the conversation starts in
- initialStage: a short snake_case stage name for the first phase of the task
- requiredSlots: 2-4 slot objects with key, label, description, required
- allowedTopicExtensions: realistic adjacent subtopics the NPC may help with after confirming the shift
- outOfScopeTopics: topics that should not replace the main task without confirmation
- completionCriteria: 2-4 concrete conditions for considering the interaction successful

## Other field rules

**desc** (English ONLY, CEFR-matched):
- A1/A2: very simple (e.g. "Ask for oat milk instead of regular milk.")
- B1/B2: intermediate (e.g. "Explain a production outage using technical vocabulary.")
- C1/C2: sophisticated (e.g. "Follow up on an unpaid invoice politely but firmly.")

**descZh**: Chinese translation of desc (≤30 chars).
**npcStatus**: short Chinese phrase describing what NPC is currently doing.

## Content Rules
- Each card MUST cover a DIFFERENT aspect, scene, or angle extracted from the video transcript.
- Scenarios should be grounded in the video content — use real topics, vocabulary, and situations from the transcript.
- Keep the language natural and conversational, NOT textbook-like.
- Scenarios can extend naturally beyond the video but must stay connected.
- openingLine language complexity must match {level}.

Return ONLY valid JSON, no markdown:
{{
  "scenarios": [
    {{
      "id": "ai-<unique 6 chars>",
      "icon": "<single emoji>",
      "category": "<2-4 Chinese chars>",
      "level": "{level}",
      "title": "<Chinese title ≤10 chars>",
      "desc": "<English task description, CEFR-appropriate for {level}>",
      "descZh": "<Chinese translation of desc ≤30 chars>",
      "npcEmoji": "<single emoji>",
      "npcName": "<NPC first name, English>",
      "npcStatus": "<short Chinese phrase describing what NPC is doing>",
      "userInitiates": <true for user_first, false for npc_first>,
      "openingLine": "<NPC's English opening line, or null>",
      "openingLineZh": "<Chinese translation of openingLine, or null>",
      "environmentalCue": "<Chinese environmental narration, or null>",
      "environmentalCueEn": "<English environmental narration, or null>",
      "npcSystemPrompt": "<1-2 English sentences about NPC role, learner role, and friction>",
      "taskContract": {{
        "objective": "<one-sentence task objective>",
        "learnerGoal": "<what the learner wants>",
        "npcRole": "<NPC role boundary>",
        "sceneFrame": "<immediate conversation context>",
        "initialStage": "<snake_case stage>",
        "requiredSlots": [
          {{
            "key": "<slot_key>",
            "label": "<human label>",
            "description": "<what must be clarified>",
            "required": true
          }}
        ],
        "allowedTopicExtensions": ["<adjacent topic>"],
        "outOfScopeTopics": ["<out of scope topic>"],
        "completionCriteria": ["<success condition>"]
      }}
    }}
  ]
}}"""


def _user_first_ratio(level: str) -> float:
    """Return the ratio of user-initiates scenarios based on CEFR level."""
    if level in ('A1', 'A2'):
        return 0.35
    if level in ('B1', 'B2'):
        return 0.65
    return 0.80  # C1, C2


def generate_practice_cards(title: str, description: str, transcript_lines: list[str],
                            cfg: dict[str, str] | None = None, level: str = 'B1') -> list[dict[str, Any]]:
    transcript_text = '\n'.join(transcript_lines[:40])

    # Decide card count heuristic based on transcript length
    line_count = len(transcript_lines)
    if line_count <= 15:
        count = 3
    elif line_count <= 50:
        count = 5
    else:
        count = min(8, 3 + line_count // 20)

    ratio = _user_first_ratio(level)
    user_first_count = round(count * ratio)
    npc_first_count = count - user_first_count

    system_prompt = _build_practice_prompt(level, count, npc_first_count, user_first_count)
    user_prompt = f"""Video title: {title}
Description: {description[:500]}
Transcript (first 40 lines):
{transcript_text}"""

    raw = _call_qwen(system_prompt, user_prompt, cfg, max_tokens=5200, json_object=True)
    result = _extract_json(raw)

    # Support both {"scenarios": [...]}, {"cards": [...]}, and bare [...] formats
    if isinstance(result, dict) and 'scenarios' in result:
        cards = result['scenarios']
    elif isinstance(result, dict) and 'cards' in result:
        cards = result['cards']
    elif isinstance(result, list):
        cards = result
    else:
        raise RuntimeError(f'AI 返回的卡片格式不正确: {raw[:200]}')

    if not isinstance(cards, list) or len(cards) < 1:
        raise RuntimeError(f'AI 返回的卡片格式不正确: {raw[:200]}')

    # Post-process: enforce field consistency per track
    for card in cards:
        card['level'] = level
        user_initiates = card.get('userInitiates', False)
        if user_initiates:
            card['openingLine'] = None
            card['openingLineZh'] = None
        else:
            card['environmentalCue'] = None
            card['environmentalCueEn'] = None
        card['taskContract'] = derive_task_contract(card, card.get('taskContract') if isinstance(card.get('taskContract'), dict) else None)

    return cards


# ---------------------------------------------------------------------------
# 2) 视频分类/标签/难度分析
# ---------------------------------------------------------------------------

CLASSIFY_SYSTEM_PROMPT = """\
You are an expert at classifying English learning video content. Given a video's title, description, and transcript excerpts, output a JSON object with:

- "level": string, one of "A1", "A2", "B1", "B2", "C1", "C2" — the CEFR level of the spoken English
- "category": string, 2–4 Chinese characters describing the content category (e.g. "酒店出行", "日常生活", "口语表达", "英语方法")
- "type": string, one of "real-scene", "vlog", "tutorial", "interview", "skit" — the video format
- "tags": array of 2-4 short English tags (e.g. ["hotel", "check-in", "travel"])
- "theme": string, one short English keyword for the main theme (e.g. "hotel", "airport", "small_talk", "slang")

Output ONLY valid JSON, no extra text."""

def classify_video(title: str, description: str, transcript_lines: list[str], cfg: dict[str, str] | None = None) -> dict[str, Any]:
    transcript_text = '\n'.join(transcript_lines[:20])
    user_prompt = f"""Video title: {title}
Description: {description[:500]}
Transcript (first 20 lines):
{transcript_text}"""

    raw = _call_qwen(CLASSIFY_SYSTEM_PROMPT, user_prompt, cfg, max_tokens=800, json_object=True)
    result = _extract_json(raw)
    if not isinstance(result, dict):
        raise RuntimeError(f'AI 分类返回格式不正确: {raw[:200]}')
    return result


# ---------------------------------------------------------------------------
# 3) json3 句子提取（复刻客户端 json3-parser.ts 逻辑）
# ---------------------------------------------------------------------------

_NON_SPEECH_RE = re.compile(r'^\[.*\]$')
_SENTENCE_END_RE = re.compile(r'[.!?]["\']* *$')
_HARD_PAUSE_SPLIT_MS = 900
_SOFT_PAUSE_SPLIT_MS = 600
_SOFT_PAUSE_MIN_TOKENS = 8
_SOFT_PAUSE_MIN_DURATION_MS = 2200
_MAX_SENTENCE_TOKENS = 14
_MAX_SENTENCE_DURATION_MS = 5200
_PUNCTUATION_RE = re.compile(r'[.!?,;:]')
_BASE_SEGMENT_ID_PREFIX = 'cc-seg'
_SEGMENT_MODE_LOCAL = 'local'
_SEGMENT_MODE_AUTO = 'auto'
_SEGMENT_MODE_AI = 'ai'
_AI_SEGMENT_BATCH_UNITS = 16
_AI_SEGMENT_BATCH_CHARS = 2600
_QUALITY_GOOD = 'good'
_QUALITY_BORDERLINE = 'borderline'
_QUALITY_BAD = 'bad'

ENGLISH_SEGMENTATION_SYSTEM_PROMPT = """\
You are a subtitle text normalizer. For each input unit, output EXACTLY ONE
segment that covers that single unit. Do NOT merge units. Do NOT split units.

HARD RULES — strict 1-to-1 mapping:
- Every input unit must appear in the output as its OWN segment.
- `startUnit` MUST equal `endUnit` for every segment.
- The number of output segments must equal the number of input units.
- Do not reorder units.
- Do not drop content. Do not invent content.

What you MAY change in the text:
- Add missing sentence-final punctuation (`.` `!` `?`).
- Add commas, apostrophes, hyphens, or dashes where grammatically needed.
- Capitalize the first letter of each sentence.
- Capitalize proper nouns (e.g. "George" not "george", "Peppa" not "peppa").
- Fix obvious ASR word errors only if you are very confident.

What you MUST NOT change:
- The words themselves.
- The order of words.

Return JSON only in this format (note: startUnit == endUnit for every segment):
{"segments":[{"startUnit":1,"endUnit":1,"text":"Tropical day trip."}, {"startUnit":2,"endUnit":2,"text":"Peppa and George are on a cruise ship holiday."}]}"""


def _normalize_space(text: str) -> str:
    return re.sub(r'\s+', ' ', text).strip()


def _to_speech_events(events: list[dict]) -> list[dict]:
    """Filter to speech events, skip window-positioning / append / non-speech."""
    result = []
    for event in events:
        if event.get('id') is not None and event.get('wpWinPosId') is not None:
            continue
        if event.get('aAppend'):
            continue
        segs = event.get('segs')
        if not segs:
            continue
        text = ''.join(s.get('utf8', '') for s in segs).replace('\n', ' ').strip()
        if not text or _NON_SPEECH_RE.match(text):
            continue
        result.append({'event': event, 'text': text})
    return result


def _to_timed_word_tokens(speech_events: list[dict]) -> list[dict]:
    """Extract word-level tokens with timing from speech events.

    每个 token 带 eventIndex 字段,方便调用方按 ASR event 边界切句
    (mirror app 端的 groupTokensByEvent)。丢掉 eventIndex 会导致
    跨 event 句子被合并,进而中英字幕 ID 错位。
    """
    tokens: list[dict] = []
    for idx, entry in enumerate(speech_events):
        event = entry['event']
        event_start_ms = int(event.get('tStartMs') or 0)
        next_start = int(speech_events[idx + 1]['event'].get('tStartMs') or 0) if idx + 1 < len(speech_events) else None
        duration_ms = event.get('dDurationMs')
        if isinstance(duration_ms, (int, float)) and duration_ms >= 0:
            display_end_ms = event_start_ms + int(duration_ms)
        elif next_start is not None and next_start > event_start_ms:
            display_end_ms = next_start
        else:
            segs = event.get('segs') or []
            offsets = [int(seg.get('tOffsetMs') or 0) for seg in segs if isinstance(seg, dict)]
            display_end_ms = event_start_ms + max(offsets, default=0)
        segment_end_ms = min(display_end_ms, next_start) if next_start is not None and next_start > 0 else display_end_ms
        segment_end_ms = max(event_start_ms, segment_end_ms)

        segs = event['segs']
        for i, seg in enumerate(segs):
            raw = seg.get('utf8', '').replace('\n', ' ')
            if not raw.strip():
                continue
            start_ms = event_start_ms + int(seg.get('tOffsetMs') or 0)
            if i < len(segs) - 1:
                end_ms = min(segment_end_ms, event_start_ms + int(segs[i + 1].get('tOffsetMs') or 0))
            else:
                end_ms = segment_end_ms
            tokens.append({
                'text': raw,
                'startMs': start_ms,
                'endMs': max(start_ms, end_ms),
                'tokenIndex': len(tokens),
                'eventIndex': idx,  # 用于按 ASR event 边界切句
            })
    return tokens


def _should_split_before_token(sentence_tokens: list[dict], next_token: dict) -> bool:
    if not sentence_tokens:
        return False

    previous_token = sentence_tokens[-1]
    gap_ms = max(0, int(next_token['startMs']) - int(previous_token['endMs']))
    sentence_duration_ms = max(0, int(previous_token['endMs']) - int(sentence_tokens[0]['startMs']))

    if gap_ms >= _HARD_PAUSE_SPLIT_MS:
        return True
    if gap_ms >= _SOFT_PAUSE_SPLIT_MS and (
        len(sentence_tokens) >= _SOFT_PAUSE_MIN_TOKENS or sentence_duration_ms >= _SOFT_PAUSE_MIN_DURATION_MS
    ):
        return True
    if len(sentence_tokens) >= _MAX_SENTENCE_TOKENS or sentence_duration_ms >= _MAX_SENTENCE_DURATION_MS:
        return True

    return False


def _finalize_sentence(tokens: list[dict], index: int) -> dict | None:
    """Build a sentence from accumulated word tokens, matching client logic."""
    if not tokens:
        return None
    words: list[dict] = []
    char_offset = 0
    for ti, token in enumerate(tokens):
        text = token['text'].lstrip() if ti == 0 else token['text']
        if not text:
            continue
        if words:
            prev_text = words[-1]['text']
            needs_space = (
                not text[0].isspace()
                and not prev_text[-1:].isspace()
                and text[0] not in ',.;:!?)]}\u005d'
            )
            if needs_space:
                text = ' ' + text
        words.append({
            'text': text,
            'startMs': token['startMs'],
            'endMs': token['endMs'],
            'charStart': char_offset,
            'charEnd': char_offset + len(text),
        })
        char_offset += len(text)
    if not words:
        return None
    full_text = ''.join(w['text'] for w in words).strip()
    return {
        'id': f'{_BASE_SEGMENT_ID_PREFIX}-{index}',
        'startMs': words[0]['startMs'],
        'endMs': words[-1]['endMs'],
        'startToken': int(tokens[0].get('tokenIndex', 0)),
        'endToken': int(tokens[-1].get('tokenIndex', max(0, len(tokens) - 1))),
        'text': full_text,
    }


def parse_json3_to_sentences(json3_path: Path) -> list[dict]:
    """Parse a json3 subtitle file into sentence-level segments.

    Returns list of {'id': 'cc-seg-N', 'startMs': int, 'endMs': int, 'text': str}.
    The segmentation logic mirrors rn-app/lib/content/json3-parser.ts exactly,
    including the critical "按 ASR event 边界切句" step: 每个 ASR event 结尾
    一定 flush 一次,丢掉 VAD 分句会导致中英字幕 ID 错位 (translations key
    cc-seg-N 跟 app 端 parseJson3Subtitles 算的 N 对不上)。
    """
    data = json.loads(json3_path.read_text('utf-8'))
    events = data.get('events', [])
    speech_events = _to_speech_events(events)
    timed_tokens = _to_timed_word_tokens(speech_events)

    # 按 ASR event 边界分组 token (mirror app 端的 groupTokensByEvent)
    # 每个内层数组对应一个 ASR event 的所有 token
    event_groups: list[list[dict]] = []
    current_group: list[dict] = []
    for token in timed_tokens:
        # 没有 eventIndex 字段时退化为旧行为,但默认会从 _to_timed_word_tokens
        # 拿到 eventIndex — 见下面给 token 补字段的逻辑
        if current_group and token.get('eventIndex') != current_group[-1].get('eventIndex'):
            event_groups.append(current_group)
            current_group = []
        current_group.append(token)
    if current_group:
        event_groups.append(current_group)

    segments: list[dict] = []

    # 每个 event 内部按标点切句,event 结尾一定 flush (mirror app 端)
    for group_tokens in event_groups:
        sentence_tokens: list[dict] = []
        for token in group_tokens:
            sentence_tokens.append(token)
            trimmed = token['text'].strip()
            if not trimmed or not _SENTENCE_END_RE.search(trimmed):
                continue
            seg = _finalize_sentence(sentence_tokens, len(segments))
            if seg:
                segments.append(seg)
            sentence_tokens = []
        # event 结尾 flush,保证每个 ASR utterance 至少落成一段
        trailing = _finalize_sentence(sentence_tokens, len(segments))
        if trailing:
            segments.append(trailing)

    return segments


def _json3_stem(json3_path: Path) -> str:
    stem = json3_path.name
    for suffix in ('.en.json3', '.json3'):
        if stem.endswith(suffix):
            return stem[:-len(suffix)]
    return json3_path.stem


def english_segmented_output_path_for_json3(json3_path: Path) -> Path:
    return json3_path.with_name(f'{_json3_stem(json3_path)}.en.segmented.json')


def _count_words(text: str) -> int:
    return len([part for part in _normalize_space(text).split(' ') if part]) if _normalize_space(text) else 0


def analyze_sentence_segmentation_quality(sentences: list[dict]) -> dict[str, Any]:
    if not sentences:
        return {
            'grade': _QUALITY_BAD,
            'recommendedMode': _SEGMENT_MODE_AI,
            'segmentCount': 0,
            'punctuatedSegmentRatio': 0.0,
            'longSegmentRatio': 1.0,
            'avgWords': 0.0,
            'maxWords': 0,
            'avgDurationMs': 0.0,
            'maxDurationMs': 0,
        }

    punctuated = 0
    long_segments = 0
    durations: list[int] = []
    word_counts: list[int] = []
    for sentence in sentences:
        text = str(sentence.get('text') or '')
        duration_ms = max(0, int(sentence.get('endMs') or 0) - int(sentence.get('startMs') or 0))
        word_count = _count_words(text)
        durations.append(duration_ms)
        word_counts.append(word_count)
        if _PUNCTUATION_RE.search(text):
            punctuated += 1
        if word_count >= 18 or duration_ms >= 7000:
            long_segments += 1

    segment_count = len(sentences)
    punctuated_ratio = punctuated / segment_count
    long_ratio = long_segments / segment_count
    avg_words = sum(word_counts) / segment_count
    max_words = max(word_counts, default=0)
    avg_duration = sum(durations) / segment_count
    max_duration = max(durations, default=0)

    if punctuated_ratio >= 0.35 and long_ratio <= 0.12 and max_words <= 18 and max_duration <= 7000:
        grade = _QUALITY_GOOD
        recommended_mode = _SEGMENT_MODE_LOCAL
    elif punctuated_ratio >= 0.12 and long_ratio <= 0.3 and max_words <= 24 and max_duration <= 12000:
        grade = _QUALITY_BORDERLINE
        recommended_mode = _SEGMENT_MODE_AI
    else:
        grade = _QUALITY_BAD
        recommended_mode = _SEGMENT_MODE_AI

    return {
        'grade': grade,
        'recommendedMode': recommended_mode,
        'segmentCount': segment_count,
        'punctuatedSegmentRatio': round(punctuated_ratio, 4),
        'longSegmentRatio': round(long_ratio, 4),
        'avgWords': round(avg_words, 2),
        'maxWords': max_words,
        'avgDurationMs': round(avg_duration, 2),
        'maxDurationMs': max_duration,
    }


def _build_ai_segmentation_batches(sentences: list[dict]) -> list[list[dict]]:
    batches: list[list[dict]] = []
    current: list[dict] = []
    current_chars = 0
    for sentence in sentences:
        line_chars = len(str(sentence.get('text') or '')) + 24
        if current and (len(current) >= _AI_SEGMENT_BATCH_UNITS or current_chars + line_chars > _AI_SEGMENT_BATCH_CHARS):
            batches.append(current)
            current = []
            current_chars = 0
        current.append(sentence)
        current_chars += line_chars
    if current:
        batches.append(current)
    return batches


def _normalize_segment_text(text: str) -> str:
    return _normalize_space(text).strip()


def _validate_ai_segment_batch(batch: list[dict], raw_segments: Any) -> list[dict]:
    """宽松验证: LLM 抽风 (合并/丢 unit) 不 raise, 缺失/合并的 unit 用本地 text 兜底.

    切段决策完全本地 (_logic_split_units), LLM 唯一作用是修标点/大写. 所以即使
    LLM 偶尔合并/丢 1-2 个 unit, 也不影响"一句一段"核心诉求 — 兜底用本地原始
    text (没修标点但不影响切段).

    返回的是展开后的 1-to-1 segment 数组, 长度 == len(batch), 顺序对齐.
    """
    if not isinstance(raw_segments, list) or not raw_segments:
        raise RuntimeError('AI 英文断句返回为空或格式不正确')

    # 按 startUnit 索引 LLM 输出 (一个 startUnit 最多对应一个 segment)
    by_start: dict[int, dict] = {}
    dropped_count = 0
    for item in raw_segments:
        if not isinstance(item, dict):
            continue
        try:
            start_u = int(item.get('startUnit') or 0)
            end_u = int(item.get('endUnit') or start_u)
        except (TypeError, ValueError):
            continue
        if start_u <= 0 or start_u > len(batch):
            continue
        if end_u < start_u or end_u > len(batch):
            end_u = start_u
        # 如果 start_u 已有, 保留第一个 (LLM 不应该重复)
        by_start.setdefault(start_u, {'startUnit': start_u, 'endUnit': end_u, 'text': str(item.get('text') or '')})

    expanded: list[dict] = []
    fallback_count = 0
    for unit_idx in range(1, len(batch) + 1):
        sentence = batch[unit_idx - 1]
        local_text = _normalize_segment_text(str(sentence.get('text') or ''))
        if unit_idx in by_start:
            seg = by_start[unit_idx]
            llm_text = _normalize_segment_text(str(seg.get('text') or ''))
            start_u = int(seg.get('startUnit') or unit_idx)
            end_u = int(seg.get('endUnit') or unit_idx)
            if start_u <= unit_idx <= end_u:
                # 这个 unit 在 LLM 输出的某个 segment 范围内
                if start_u == unit_idx:
                    # 拿到 LLM 修过的 text (作为该 segment 的第一个 unit)
                    text = llm_text or local_text
                else:
                    # LLM 合并到前一个 segment, 本 unit 拿不到 LLM 修的 text
                    # 用本地原始 text 兜底
                    text = local_text
                    fallback_count += 1
            else:
                text = local_text
                fallback_count += 1
        else:
            # LLM 没输出这个 unit, 用本地 text
            text = local_text
            fallback_count += 1
        expanded.append({
            'startToken': int(sentence.get('startToken') or 0),
            'endToken': int(sentence.get('endToken') or 0),
            'startMs': int(sentence.get('startMs') or 0),
            'endMs': int(sentence.get('endMs') or 0),
            'text': text,
        })

    # trace: 报告 LLM 抽风程度
    if dropped_count > 0 or fallback_count > 0 or len(by_start) != len(batch):
        print(
            f'  [AI 断句] batch len={len(batch)} llmSegments={len(by_start)} '
            f'fallbackUnits={fallback_count} (用本地 text 兜底)'
        )

    return expanded


# 2026-08-15: 纯逻辑拆分 — LLM 只修标点/大写, 本地规则按标点切/合并.
# 切段决策完全本地、确定性, LLM 怎么抽风都不影响"一句一段"核心诉求.
_UNIT_END_PUNC_RE = re.compile(r'[.!?。！？]["\')]*\s*$')


def _looks_like_complete_sentence(text: str) -> bool:
    """判断一段 text 是不是以 sentence-final punctuation 结尾 (即完整句)."""
    return bool(_UNIT_END_PUNC_RE.search((text or '').rstrip()))


def _build_segment_from_units(units: list[dict]) -> dict:
    """把一组 unit 合并成一个 segment 字典 (startToken/endToken/startMs/endMs/text)."""
    if not units:
        return {
            'startToken': 0,
            'endToken': 0,
            'startMs': 0,
            'endMs': 0,
            'text': '',
        }
    if len(units) == 1:
        sentence = units[0]
        return {
            'startToken': int(sentence.get('startToken') or 0),
            'endToken': int(sentence.get('endToken') or 0),
            'startMs': int(sentence.get('startMs') or 0),
            'endMs': int(sentence.get('endMs') or 0),
            'text': str(sentence.get('text') or '').strip(),
        }
    # 多个 unit 合并: token/ms 取首尾, text 用空格拼接 (LLM 已修好空格)
    first = units[0]
    last = units[-1]
    text = ' '.join(str(u.get('text') or '').strip() for u in units).strip()
    # 合并空格的连字符 (e.g. "to-" + "day" → "to-day"), 简单处理就行
    text = re.sub(r'\s*-\s+', '-', text)  # "to - day" → "to-day"
    text = re.sub(r'\s+', ' ', text)
    return {
        'startToken': int(first.get('startToken') or 0),
        'endToken': int(last.get('endToken') or 0),
        'startMs': int(first.get('startMs') or 0),
        'endMs': int(last.get('endMs') or 0),
        'text': text,
    }


def _logic_split_units(units: list[dict]) -> list[dict]:
    """纯逻辑拆分: 按标点切/合并 fragment.

    规则:
    - 标点结尾的 unit → 闭合当前段, 落成一段
    - 没标点的 unit (fragment) → 跟后续 unit 合并, 直到遇到有标点的
    - 末尾 fragment → 跟最后一段合并 (如果有), 否则独立成段

    LLM 只修标点/大写, 不参与切段决策. 这样 100% 稳定可重现.
    """
    if not units:
        return []
    out: list[dict] = []
    buf: list[dict] = []
    for unit in units:
        buf.append(unit)
        if _looks_like_complete_sentence(str(unit.get('text') or '')):
            out.append(_build_segment_from_units(buf))
            buf = []
    # 末尾 fragment: 跟最后一段合并 (如果有), 否则独立
    if buf:
        if out:
            last = out[-1]
            # 把最后一段还原成 unit dict, 再跟 buf 合并
            last_as_unit = {
                'startToken': last['startToken'],
                'endToken': last['endToken'],
                'startMs': last['startMs'],
                'endMs': last['endMs'],
                'text': last['text'],
            }
            out[-1] = _build_segment_from_units([last_as_unit] + buf)
        else:
            out.append(_build_segment_from_units(buf))
    return out


def _apply_ai_text_corrections_then_split(batch: list[dict], ai_segments: list[dict]) -> list[dict]:
    """把 LLM 修过的 1-to-1 segments 按逻辑拆分规则切/合并.

    流程: ai_segments[i] 是 unit i 修过的 text. 按标点切/合并:
    - 修过的 text 以 . ! ? 结尾 → 闭合当前段
    - 修过的 text 无句末标点 → fragment, 跟下一个合并
    """
    if len(ai_segments) != len(batch):
        # _validate_ai_segment_batch 应该已经 raise 了, 这里兜底
        raise RuntimeError(f'AI segments 数量不匹配: {len(ai_segments)} vs {len(batch)}')
    # 把 ai_segments 的 text 覆盖到 batch 对应 unit 上, 保留 batch 的 token/ms
    corrected_units: list[dict] = []
    for unit, seg in zip(batch, ai_segments):
        corrected_units.append({
            'startToken': int(unit.get('startToken') or 0),
            'endToken': int(unit.get('endToken') or 0),
            'startMs': int(unit.get('startMs') or 0),
            'endMs': int(unit.get('endMs') or 0),
            'text': str(seg.get('text') or '').strip(),
        })
    return _logic_split_units(corrected_units)


def _ai_correct_sentence_segments(sentences: list[dict], cfg: dict[str, str] | None = None, on_progress: Any = None) -> list[dict]:
    """2026-08-15: LLM 只修标点/大写, 本地规则按标点切/合并.

    流程: LLM 1-to-1 输出 (修标点/大写) → 本地 _logic_split_units 按标点切/合并.
    切段决策完全本地, LLM 抽风最多影响标点美观, 不影响"一句一段".
    """
    corrected: list[dict] = []
    batches = _build_ai_segmentation_batches(sentences)
    processed = 0
    for batch_index, batch in enumerate(batches, start=1):
        numbered_lines = []
        for unit_index, sentence in enumerate(batch, start=1):
            numbered_lines.append(f'{unit_index}. {sentence.get("text") or ""}')
        user_prompt = '\n'.join([
            'Normalize the following subtitle units (one output segment per unit).',
            'Return JSON only.',
            '',
            *numbered_lines,
        ])
        if on_progress:
            on_progress(f'  英文断句 AI 矫正中: batch {batch_index}/{len(batches)}（{processed + 1}-{processed + len(batch)} / {len(sentences)} unit）')
        raw = _call_qwen(ENGLISH_SEGMENTATION_SYSTEM_PROMPT, user_prompt, cfg, max_tokens=1800, json_object=True)
        payload = _extract_json(raw)
        ai_segments = _validate_ai_segment_batch(batch, payload.get('segments'))
        # 1-to-1 验证通过后, 本地按标点切/合并
        batch_segments = _apply_ai_text_corrections_then_split(batch, ai_segments)
        corrected.extend(batch_segments)
        processed += len(batch)

    for index, segment in enumerate(corrected):
        segment['id'] = f'{_BASE_SEGMENT_ID_PREFIX}-{index}'
    return corrected


def _build_segmented_english_payload(source_subtitle: str, segments: list[dict], quality: dict[str, Any], *, mode: str, used_ai: bool) -> dict[str, Any]:
    return {
        'sourceSubtitle': source_subtitle,
        'segmentCount': len(segments),
        'segmentationMode': mode,
        'usedAiCorrection': used_ai,
        'quality': quality,
        'segments': segments,
    }


def generate_english_segmented_subtitle_file(
    json3_path: Path,
    output_path: Path | None = None,
    cfg: dict[str, str] | None = None,
    correction_mode: str = _SEGMENT_MODE_AUTO,
    on_progress: Any = None,
) -> dict[str, Any]:
    sentences = parse_json3_to_sentences(json3_path)
    if not sentences:
        raise RuntimeError(f'字幕文件中没有找到有效句子: {json3_path.name}')

    quality = analyze_sentence_segmentation_quality(sentences)
    mode = correction_mode if correction_mode in {_SEGMENT_MODE_LOCAL, _SEGMENT_MODE_AUTO, _SEGMENT_MODE_AI} else _SEGMENT_MODE_AUTO
    should_use_ai = mode == _SEGMENT_MODE_AI

    if on_progress:
        on_progress(
            '  英文断句质量评估: '
            f"{quality.get('grade')} · 标点覆盖 {quality.get('punctuatedSegmentRatio')} · 长段占比 {quality.get('longSegmentRatio')}"
        )

    segments = sentences
    used_ai = False
    if should_use_ai:
        if on_progress:
            on_progress('  英文断句模式: 使用 AI 矫正并生成完整英文句子…')
        try:
            segments = _ai_correct_sentence_segments(sentences, cfg, on_progress)
            used_ai = True
        except Exception as exc:
            if on_progress:
                on_progress(f'  AI 英文断句失败，回退本地断句: {exc}')
            segments = sentences
            used_ai = False
    elif on_progress:
        on_progress('  英文断句模式: 使用本地断句结果生成英文句子文件…')

    payload = _build_segmented_english_payload(
        json3_path.name,
        segments,
        quality,
        mode=mode,
        used_ai=used_ai,
    )
    target_path = output_path or english_segmented_output_path_for_json3(json3_path)
    target_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), 'utf-8')
    if on_progress:
        on_progress(f'  已保存英文句子文件 {target_path.name}（{len(segments)} 句）')
    return payload


def load_english_segmented_subtitle_file(path: Path) -> list[dict]:
    payload = json.loads(path.read_text('utf-8'))
    segments = payload.get('segments')
    if not isinstance(segments, list):
        raise RuntimeError(f'英文句子文件格式不正确: {path.name}')
    return [segment for segment in segments if isinstance(segment, dict) and str(segment.get('text') or '').strip()]


# ---------------------------------------------------------------------------
# 4) 批量字幕翻译
# ---------------------------------------------------------------------------

TRANSLATE_SYSTEM_PROMPT = """\
You are a professional English-to-Chinese subtitle translator. Translate each numbered English sentence to natural, fluent Chinese.

Rules:
- Keep the same numbering.
- One translation per line, format: "N. Chinese translation"
- Translate meaning faithfully but use natural spoken Chinese, not literal translation.
- Keep it concise — subtitles should be short.
- Do NOT add any explanation or extra text.
- Do NOT wrap in code fences."""

BATCH_SIZE = 25
MAX_TRANSLATE_BATCH_CHARS = 1800
MAX_TRANSLATE_UNIT_WORDS = 48
MAX_TRANSLATE_UNIT_CHARS = 280


def _split_text_for_translation(text: str) -> list[str]:
    normalized = _normalize_space(text)
    if not normalized:
        return []
    words = normalized.split()
    if len(words) <= MAX_TRANSLATE_UNIT_WORDS and len(normalized) <= MAX_TRANSLATE_UNIT_CHARS:
        return [normalized]

    pieces: list[str] = []
    current: list[str] = []
    current_chars = 0
    for word in words:
        extra_chars = len(word) + (1 if current else 0)
        if current and (len(current) >= MAX_TRANSLATE_UNIT_WORDS or current_chars + extra_chars > MAX_TRANSLATE_UNIT_CHARS):
            pieces.append(' '.join(current))
            current = [word]
            current_chars = len(word)
            continue
        current.append(word)
        current_chars += extra_chars
    if current:
        pieces.append(' '.join(current))
    return pieces


def _prepare_translation_units(sentences: list[dict]) -> list[dict[str, str]]:
    units: list[dict[str, str]] = []
    for sentence in sentences:
        sentence_id = str(sentence.get('id') or '')
        text = str(sentence.get('text') or '')
        for idx, piece in enumerate(_split_text_for_translation(text)):
            units.append({
                'unit_id': f'{sentence_id}#{idx}',
                'sentence_id': sentence_id,
                'text': piece,
            })
    return units


def _build_translation_batches(units: list[dict[str, str]]) -> list[list[dict[str, str]]]:
    batches: list[list[dict[str, str]]] = []
    current_batch: list[dict[str, str]] = []
    current_chars = 0
    for unit in units:
        line = unit['text']
        line_chars = len(line) + 8
        if current_batch and (len(current_batch) >= BATCH_SIZE or current_chars + line_chars > MAX_TRANSLATE_BATCH_CHARS):
            batches.append(current_batch)
            current_batch = []
            current_chars = 0
        current_batch.append(unit)
        current_chars += line_chars
    if current_batch:
        batches.append(current_batch)
    return batches


def translate_subtitles(
    sentences: list[dict],
    cfg: dict[str, str] | None = None,
    on_progress: Any = None,
) -> dict[str, str]:
    """Translate a list of sentence dicts (with 'id' and 'text') to Chinese.

    Returns a dict mapping segment id -> Chinese translation.
    Calls AI in batches of BATCH_SIZE sentences.
    """
    translations: dict[str, str] = {}
    total = len(sentences)
    units = _prepare_translation_units(sentences)
    unit_total = len(units)
    if not units:
        return translations
    grouped_parts: dict[str, list[str]] = {str(sentence.get('id') or ''): [] for sentence in sentences}
    batches = _build_translation_batches(units)

    translated_units = 0
    for batch in batches:
        numbered_lines = []
        for i, unit in enumerate(batch, start=translated_units + 1):
            numbered_lines.append(f'{i}. {unit["text"]}')
        user_prompt = '\n'.join(numbered_lines)

        if on_progress:
            on_progress(f'  翻译中: {translated_units + 1}-{translated_units + len(batch)}/{unit_total} 片段（原始 {total} 句）')

        raw = _call_qwen(TRANSLATE_SYSTEM_PROMPT, user_prompt, cfg)

        batch_parts: dict[str, list[str]] = {}
        for line in raw.strip().splitlines():
            line = line.strip()
            if not line:
                continue
            m = re.match(r'^(\d+)\.\s*(.+)$', line)
            if m:
                num = int(m.group(1))
                zh_text = m.group(2).strip()
                idx = num - translated_units - 1
                if 0 <= idx < len(batch):
                    sentence_id = batch[idx]['sentence_id']
                    batch_parts.setdefault(sentence_id, []).append(zh_text)
        for sentence_id, parts in batch_parts.items():
            grouped_parts.setdefault(sentence_id, []).extend(parts)
        translated_units += len(batch)

    for sentence in sentences:
        sentence_id = str(sentence.get('id') or '')
        merged = ''.join(part.strip() for part in grouped_parts.get(sentence_id, []) if part.strip()).strip()
        if merged:
            translations[sentence_id] = merged

    return translations


def generate_zh_subtitle_file(
    json3_path: Path,
    output_path: Path,
    cfg: dict[str, str] | None = None,
    on_progress: Any = None,
    correction_mode: str = _SEGMENT_MODE_LOCAL,
) -> dict[str, str]:
    """Full pipeline: parse json3 -> translate -> save .zh.json.

    Returns the translations dict.
    """
    english_output_path = english_segmented_output_path_for_json3(json3_path)
    english_payload = generate_english_segmented_subtitle_file(
        json3_path,
        english_output_path,
        cfg,
        correction_mode=correction_mode,
        on_progress=on_progress,
    )
    sentences = [segment for segment in english_payload.get('segments', []) if isinstance(segment, dict)]
    if not sentences:
        raise RuntimeError(f'字幕文件中没有找到有效句子: {json3_path.name}')

    if on_progress:
        on_progress(f'  提取到 {len(sentences)} 个句子，开始翻译…')

    translations = translate_subtitles(sentences, cfg, on_progress)

    if on_progress:
        on_progress(f'  翻译完成，正在保存到 {output_path.name}…')

    payload = {
        'sourceSubtitle': json3_path.name,
        'sourceEnglishSubtitle': english_output_path.name,
        'segmentCount': len(sentences),
        'translations': translations,
    }
    with output_path.open('w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)

    if on_progress:
        on_progress(f'  已保存 {output_path.name}')

    return translations
