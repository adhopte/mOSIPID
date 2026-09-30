"""Add/replace locale rows in en/fr/es JSON at once: from locale_tool import add; add([(key, en, fr, es), ...])"""
import json, os
D = os.path.join(os.path.dirname(__file__), '..', 'packages', 'core', 'src', 'locales')
def add(rows):
    data = {}
    for lang in ('en', 'fr', 'es'):
        data[lang] = json.load(open(os.path.join(D, lang + '.json'), encoding='utf-8'))
    for k, en, fr, es in rows:
        data['en'][k], data['fr'][k], data['es'][k] = en, fr, es
    for lang, d in data.items():
        json.dump(d, open(os.path.join(D, lang + '.json'), 'w', encoding='utf-8'), ensure_ascii=False, indent=1, sort_keys=True)
    print('locale rows:', len(rows), '| total keys:', len(data['en']))
