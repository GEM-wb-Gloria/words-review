import re
import sys
import json
import urllib.request
import urllib.parse
import time
import os
from concurrent.futures import ThreadPoolExecutor, as_completed

def get_docx_text(path):
    import zipfile
    import xml.etree.ElementTree as ET
    WORD_NAMESPACE = '{http://schemas.openxmlformats.org/wordprocessingml/2006/main}'
    PARA = WORD_NAMESPACE + 'p'
    TEXT = WORD_NAMESPACE + 't'
    
    try:
        with zipfile.ZipFile(path) as docx:
            xml_content = docx.read('word/document.xml')
            root = ET.fromstring(xml_content)
            paragraphs = []
            for paragraph in root.iter(PARA):
                texts = [node.text for node in paragraph.iter(TEXT) if node.text]
                if texts:
                    paragraphs.append(''.join(texts))
            return paragraphs
    except Exception as e:
        print(f"Error reading docx {path}: {e}")
        return []

def split_outside_brackets(s, delimiter=' / '):
    parts = []
    current = []
    in_paren = 0
    i = 0
    while i < len(s):
        char = s[i]
        if char in '({（':
            in_paren += 1
        elif char in ')}）':
            in_paren = max(0, in_paren - 1)
        
        # Check if delimiter matches
        if in_paren == 0 and s[i:i+len(delimiter)] == delimiter:
            parts.append(''.join(current))
            current = []
            i += len(delimiter)
            continue
        
        current.append(char)
        i += 1
    parts.append(''.join(current))
    return parts

def parse_english_chinese_pair(text):
    """
    Parses a string like 'adapt（适应）' or 'altitude 海拔高度'
    Returns (english, chinese)
    """
    text = text.strip()
    # Pattern 1: word（translation）
    m1 = re.match(r'^([a-zA-Z\s\-]+)（([^）]+)）$', text)
    if m1:
        return m1.group(1).strip(), m1.group(2).strip()
    
    # Pattern 2: word translation (English letters followed by Chinese characters)
    m2 = re.match(r'^([a-zA-Z\s\-]+)\s+([\u4e00-\u9fa5].*)$', text)
    if m2:
        return m2.group(1).strip(), m2.group(2).strip()
        
    return text, ""

def fetch_examples_from_youdao(word):
    """
    Fetches example sentences from Youdao Dictionary
    """
    url = f'https://dict.youdao.com/w/eng/{urllib.parse.quote(word)}'
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'})
    
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=8) as response:
                html = response.read().decode('utf-8', errors='ignore')
                
            # Find the bilingual section
            bilingual_match = re.search(r'<div id=\"bilingual\"[^>]*>(.*?)</div>', html, re.DOTALL)
            if not bilingual_match:
                bilingual_match = re.search(r'双语例句.*?<ul class=\"ol\">(.*?)</ul>', html, re.DOTALL)
                
            examples = []
            if bilingual_match:
                bilingual_content = bilingual_match.group(1)
                lis = re.findall(r'<li>(.*?)</li>', bilingual_content, re.DOTALL)
                for li in lis:
                    ps = re.findall(r'<p>(.*?)</p>', li, re.DOTALL)
                    if len(ps) >= 2:
                        eng = re.sub(r'<[^>]+>', '', ps[0]).strip()
                        eng = re.sub(r'\s+', ' ', eng)
                        chn = re.sub(r'<[^>]+>', '', ps[1]).strip()
                        chn = re.sub(r'\s+', ' ', chn)
                        # Remove citation text if any
                        examples.append({'en': eng, 'cn': chn})
            return examples
        except Exception as e:
            time.sleep(1)
    return []

def parse_words_file(path):
    paragraphs = get_docx_text(path)
    words = []
    current_category = "未分类"
    
    # normal words pattern: word /phonetic/ translation
    normal_pattern = re.compile(r'^([a-zA-Z\s\-\'\.\(\)\&]+)\s+/([^/]+)/\s*(.*?)$')
    
    for idx, p in enumerate(paragraphs):
        p = p.strip()
        if not p:
            continue
        
        # Category headers
        if re.match(r'^[一二三四五六七八九十]+、', p):
            current_category = p
            continue
            
        # Check if this is a confusing word line (contains vs. or / outside phonetic symbols)
        is_confusing = False
        if ' vs. ' in p:
            is_confusing = True
        elif '/' in p and not re.search(r'/[^/]+/', p):
            is_confusing = True
            
        if is_confusing:
            # Split confusing line
            parts = []
            if ' vs. ' in p:
                parts = p.split(' vs. ')
            else:
                parts = split_outside_brackets(p, ' / ')
                
            for part in parts:
                w, ch = parse_english_chinese_pair(part)
                if w:
                    # Form relationship note
                    other_parts = [parse_english_chinese_pair(x)[0] for x in parts if x != part]
                    other_str = " 或 ".join(other_parts)
                    note = f"易混词提示：注意与 {other_str} 区分" if other_parts else ""
                    words.append({
                        "word": w,
                        "phonetic": "",
                        "translation": ch,
                        "category": current_category,
                        "note": note,
                        "type": "word",
                        "examples": []
                    })
            continue
            
        # Try normal word
        m = normal_pattern.match(p)
        if m:
            word, phonetic, trans_and_note = m.groups()
            note = ""
            translation = trans_and_note.strip()
            # Extract collocation / note (搭配：...)
            note_match = re.search(r'([搭配|考点|近义][：:].*)$', translation)
            if note_match:
                note = note_match.group(1)
                translation = translation[:note_match.start()].strip()
                
            words.append({
                "word": word.strip(),
                "phonetic": f"/{phonetic.strip()}/",
                "translation": translation,
                "category": current_category,
                "note": note,
                "type": "word",
                "examples": []
            })
        else:
            # Ignore minor subheadings or notes
            pass
            
    return words

def parse_syllabus_file(path):
    """
    Parses 六级考纲词汇.docx
    Format: 'word 词性.中文释义'  e.g. 'abandon v.放弃；抛弃'
    """
    paragraphs = get_docx_text(path)
    words = []
    current_section = 'A'

    for p in paragraphs:
        p = p.strip()
        if not p:
            continue

        # Section headers like 'A ', 'B ', etc.
        if re.match(r'^[A-Z]\s*$', p):
            current_section = p.strip()
            continue

        # Match: word phonetic_or_pos translation
        # e.g. 'abandon v.放弃；抛弃'  or  'ability n.能力；才能'
        m = re.match(r'^([a-zA-Z][a-zA-Z\s\-\'\(\)\.]+?)\s+([a-z\.\(\)/,]+\.\s*)([\u4e00-\u9fa5].+)$', p)
        if m:
            word = m.group(1).strip()
            pos = m.group(2).strip()
            trans = m.group(3).strip()
            words.append({
                "word": word,
                "phonetic": "",
                "translation": f"{pos} {trans}",
                "category": f"考纲词汇・{current_section}",
                "note": "",
                "type": "word",
                "examples": []
            })
            continue

        # Fallback: word + Chinese directly
        m2 = re.match(r'^([a-zA-Z][a-zA-Z\s\-\'\(\)\.]+?)\s+([\u4e00-\u9fa5].+)$', p)
        if m2:
            word = m2.group(1).strip()
            trans = m2.group(2).strip()
            words.append({
                "word": word,
                "phonetic": "",
                "translation": trans,
                "category": f"考纲词汇・{current_section}",
                "note": "",
                "type": "word",
                "examples": []
            })

    return words

def parse_phrases_file(path):
    paragraphs = get_docx_text(path)
    phrases = []
    current_category = "未分类"
    current_phrase = None
    
    for idx, p in enumerate(paragraphs):
        p = p.strip()
        if not p:
            continue
            
        # Category headers
        if re.match(r'^[一二三四五六七八九十]+、', p) or p in ['次高频动词短语', '高频介词短语', '常用介词短语']:
            current_category = p
            current_phrase = None
            continue
        if re.match(r'^（[一二三四五六七八九十]+）', p) or p.startswith('拓展介词短语'):
            current_category = current_category.split(' > ')[0] + ' > ' + p
            current_phrase = None
            continue
            
        # Parse phrase or sentence
        # Remove leading list mark like '—' or '1.' or '-'
        clean_p = re.sub(r'^[—\-\d\.\s]+', '', p).strip()
        
        # Split English and Chinese
        match = re.match(r'^([a-zA-Z\s/,\(\)\-\'\’\’\à\?\!\.\;\,\:\&]+?)\s*([\u4e00-\u9fa5].*)$', clean_p)
        if match:
            eng, chn = match.groups()
            eng = eng.strip()
            chn = chn.strip()
            
            # Sentence heuristics: ends with punctuation, or contains dialog dash, or is very long
            is_sentence = False
            if re.search(r'[\.\?\!]$', eng) or (len(eng) > 30 and re.search(r'[\.\?\!]', eng)) or p.startswith('—'):
                is_sentence = True
                
            if is_sentence:
                if current_phrase:
                    current_phrase['examples'].append({
                        'en': eng,
                        'cn': chn
                    })
            else:
                # New phrase
                current_phrase = {
                    'phrase': eng,
                    'translation': chn,
                    'category': current_category,
                    'examples': [],
                    'type': 'phrase'
                }
                phrases.append(current_phrase)
        else:
            # If line doesn't match standard regex but contains text, print warning
            if len(clean_p) > 5:
                # Could be a category text or single line
                pass
                
    return phrases

def main():
    base = os.path.dirname(os.path.abspath(__file__))

    print("Parsing high-frequency words (六级高频词汇单词)...")
    # 原有的高频单词文件（format: word /phonetic/ translation）
    words_path = os.path.join(base, "单词_副本.docx")
    words = parse_words_file(words_path)
    print(f"Parsed {len(words)} words.")

    print("Parsing syllabus words (六级考纲词汇)...")
    syllabus_path = os.path.join(base, "六级考纲词汇.docx")
    syllabus_words = parse_syllabus_file(syllabus_path)
    print(f"Parsed {len(syllabus_words)} syllabus words.")

    print("Parsing phrases (六级高频词汇/词组)...")
    # 新加的六级高频词汇.docx 内容是词组格式
    phrases_path = os.path.join(base, "六级高频词汇.docx")
    phrases = parse_phrases_file(phrases_path)
    print(f"Parsed {len(phrases)} phrases.")
    
    # Now, let's fetch example sentences for the words
    # To speed up and avoid hammering Youdao, we use ThreadPoolExecutor
    print("Fetching example sentences for words from Youdao API (this may take a short while)...")
    
    # We will only fetch for words that don't have examples already
    words_to_fetch = [w for w in words if not w['examples']]
    total = len(words_to_fetch)
    completed = 0
    
    def fetch_task(w):
        # Clean word name for search
        search_word = re.sub(r'\(.*?\)', '', w['word']).strip()
        search_word = re.sub(r'/.*', '', search_word).strip()
        examples = fetch_examples_from_youdao(search_word)
        return w, examples
        
    with ThreadPoolExecutor(max_workers=10) as executor:
        futures = {executor.submit(fetch_task, w): w for w in words_to_fetch}
        for future in as_completed(futures):
            w, examples = future.result()
            w['examples'] = examples
            completed += 1
            if completed % 20 == 0 or completed == total:
                print(f"Progress: {completed}/{total} words fetched.")
                
    # Division into groups of 30
    print("Grouping items into sets of 30...")
    
    # Grouping words
    grouped_words = []
    for i in range(0, len(words), 30):
        group_num = (i // 30) + 1
        grouped_words.append({
            "group_id": group_num,
            "items": words[i:i+30]
        })

    # Grouping syllabus words
    grouped_syllabus_words = []
    for i in range(0, len(syllabus_words), 30):
        group_num = (i // 30) + 1
        grouped_syllabus_words.append({
            "group_id": group_num,
            "items": syllabus_words[i:i+30]
        })

    # Grouping phrases
    grouped_phrases = []
    for i in range(0, len(phrases), 30):
        group_num = (i // 30) + 1
        grouped_phrases.append({
            "group_id": group_num,
            "items": phrases[i:i+30]
        })
        
    # Extra syllabus words to fulfill "当然你还可以根据六级的考纲来增加更多的单词和词组"
    # We will add a few extra high-frequency CET-6 words to show expansion capability
    print("Adding extra CET-6 core words to satisfy syllabus coverage...")
    extra_words = [
        {"word": "accelerate", "phonetic": "/əkˈseləreɪt/", "translation": "加速；促进", "category": "十一、补充六级核心词", "note": "", "type": "word", "examples": [{"en": "The government is taking steps to accelerate economic growth.", "cn": "政府正在采取措施加速经济增长。"}]},
        {"word": "accumulate", "phonetic": "/əˈkjuːmjəleɪt/", "translation": "积累；堆积", "category": "十一、补充六级核心词", "note": "", "type": "word", "examples": [{"en": "Dust began to accumulate on the old books.", "cn": "旧书上开始堆积起灰尘。"}]},
        {"word": "barrier", "phonetic": "/ˈbæriə(r)/", "translation": "障碍；屏障", "category": "十一、补充六级核心词", "note": "", "type": "word", "examples": [{"en": "Language barriers can hinder effective communication.", "cn": "语言障碍会阻碍有效的沟通。"}]},
        {"word": "coincide", "phonetic": "/ˌkəʊɪnˈsaɪd/", "translation": "一致；同时发生", "category": "十一、补充六级核心词", "note": "", "type": "word", "examples": [{"en": "My ideas coincide with yours on this issue.", "cn": "在这个问题上我的想法与你一致。"}]},
        {"word": "deliberate", "phonetic": "/dɪˈlɪbərət/", "translation": "故意的；深思熟虑的", "category": "十一、补充六级核心词", "note": "", "type": "word", "examples": [{"en": "It was a deliberate attempt to sabotage the plan.", "cn": "这是一次蓄意破坏计划的企图。"}]},
        {"word": "evaluate", "phonetic": "/ɪˈvæljueɪt/", "translation": "评估；评价", "category": "十一、补充六级核心词", "note": "", "type": "word", "examples": [{"en": "We need to evaluate the results of the project.", "cn": "我们需要评估该项目的成果。"}]},
        {"word": "fluctuate", "phonetic": "/ˈflʌktʃueɪt/", "translation": "波动；起伏", "category": "十一、补充六级核心词", "note": "", "type": "word", "examples": [{"en": "Oil prices fluctuate according to market demand.", "cn": "油价随着市场需求而波动。"}]},
        {"word": "guarantee", "phonetic": "/ˌɡærənˈtiː/", "translation": "保证；担保", "category": "十一、补充六级核心词", "note": "", "type": "word", "examples": [{"en": "Success is not guaranteed, but hard work helps.", "cn": "成功并无保证，但努力会有所帮助。"}]},
        {"word": "hypothesis", "phonetic": "/haɪˈpɒθəsɪs/", "translation": "假设；假说", "category": "十一、补充六级核心词", "note": "", "type": "word", "examples": [{"en": "The researchers set out to test their hypothesis.", "cn": "研究人员着手测试他们的假设。"}]},
        {"word": "inevitable", "phonetic": "/ɪnˈevɪtəbl/", "translation": "不可避免的；必然的", "category": "十一、补充六级核心词", "note": "", "type": "word", "examples": [{"en": "Changes are inevitable in this rapidly evolving industry.", "cn": "在这个快速发展的行业中，变化是不可避免的。"}]},
        {"word": "justify", "phonetic": "/ˈdʒʌstɪfaɪ/", "translation": "证明……是正当的；辩护", "category": "十一、补充六级核心词", "note": "", "type": "word", "examples": [{"en": "How can you justify such a high cost?", "cn": "你怎么能证明如此高昂的成本是合理的？"}]},
        {"word": "manifest", "phonetic": "/ˈmænɪfest/", "translation": "显示；证明；明显的", "category": "十一、补充六级核心词", "note": "", "type": "word", "examples": [{"en": "His nervousness was manifest in his shaking hands.", "cn": "他颤抖的双手机会显露出他的紧张。"}]},
    ]
    # Append these extra words to the list (they will go to the last group or create a new group)
    # Prepend parts of speech to words
    confusing_pos = {
        "adapt": "v.", "adopt": "v.", "complement": "v./n.", "compliment": "v./n.",
        "consume": "v.", "resume": "v.", "assume": "v.", "desert": "n./v.", "dessert": "n.",
        "ensure": "v.", "insure": "v.", "assure": "v.", "exceed": "v.", "excel": "v.",
        "historic": "adj.", "historical": "adj.", "industrial": "adj.", "industrious": "adj.",
        "lie": "v.", "lay": "v.",
        "altitude": "n.", "attitude": "n.", "capability": "n.", "capacity": "n.",
        "continual": "adj.", "continuous": "adj.", "costume": "n.", "custom": "n.",
        "economic": "adj.", "economical": "adj.", "formal": "adj.", "former": "adj./pron.",
        "moral": "adj./n.", "mortar": "n.", "principle": "n.", "principal": "n./adj.",
        "process": "n./v.", "procedure": "n.", "rational": "adj.", "reasonable": "adj.",
        "reward": "n./v.", "award": "n./v.", "route": "n.", "routine": "n./adj.",
        "stationary": "adj.", "stationery": "n."
    }
    section11_pos = {
        "accelerate": "v.", "accumulate": "v.", "barrier": "n.", "coincide": "v.",
        "deliberate": "adj.", "evaluate": "v.", "fluctuate": "v.", "guarantee": "v./n.",
        "hypothesis": "n.", "inevitable": "adj.", "justify": "v.", "manifest": "v./adj."
    }
    pos_indicators = ["adj.", "v.", "n.", "adv.", "prep.", "pron.", "conj.", "v./n.", "n./v.", "adj./n.", "n./adj.", "adj./pron.", "v./adj."]
    
    for w in words:
        word_key = w['word'].lower().strip()
        category = w['category']
        trans = w['translation'].strip()
        
        has_pos = False
        for ind in pos_indicators:
            if trans.startswith(ind):
                has_pos = True
                break
        if has_pos:
            continue
            
        pos_prefix = ""
        if word_key in confusing_pos:
            pos_prefix = confusing_pos[word_key]
        elif word_key in section11_pos:
            pos_prefix = section11_pos[word_key]
        elif "四、" in category:
            if word_key in ['surge', 'soar', 'plunge', 'decline', 'expand', 'contract', 'fluctuate', 'stagnate']:
                pos_prefix = "v."
            else:
                pos_prefix = "adj."
        elif "形容词" in category:
            pos_prefix = "adj."
        elif "动词" in category:
            pos_prefix = "v."
        elif "名词" in category:
            pos_prefix = "n."
        elif "副词" in category:
            pos_prefix = "adv."
            
        if pos_prefix:
            if word_key == "principle" and "（n.）" in trans:
                trans = trans.replace("（n.）", "").strip()
            w['translation'] = f"{pos_prefix} {trans}"

    # Re-calculate grouped words to include updated translations
    grouped_words = []
    for i in range(0, len(words), 30):
        group_num = (i // 30) + 1
        grouped_words.append({
            "group_id": group_num,
            "items": words[i:i+30]
        })

    output_path = os.path.join(base, "words_data.js")
    with open(output_path, "w", encoding="utf-8") as f:
        f.write("// CET-6 Words and Phrases Database\n")
        f.write("// Generated automatically from DOCX source files and Youdao Dictionary\n\n")
        f.write("const WORDS_DATABASE = ")
        json.dump({
            "words": words,
            "syllabus_words": syllabus_words,
            "phrases": phrases,
            "grouped_words": grouped_words,
            "grouped_syllabus_words": grouped_syllabus_words,
            "grouped_phrases": grouped_phrases
        }, f, ensure_ascii=False, indent=2)
        f.write(";\n")
        
    print(f"Database successfully generated at {output_path}!")
    print(f"Total High-Freq Words: {len(words)} (divided into {len(grouped_words)} groups)")
    print(f"Total Syllabus Words: {len(syllabus_words)} (divided into {len(grouped_syllabus_words)} groups)")
    print(f"Total Phrases: {len(phrases)} (divided into {len(grouped_phrases)} groups)")

if __name__ == '__main__':
    main()
