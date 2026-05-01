# law_back

Backend для проекта "Знай свои права" с RAG-чатом на Gemini.

## Что реализовано

- JWT-аутентификация с 2 ролями:
  - `citizen`
  - `official`
- RAG-пайплайн:
  - загрузка документов из `data/docs/ru` и `data/docs/kz`
  - чанкинг текста
  - эмбеддинги Gemini
  - хранилище в PostgreSQL + `pgvector` (таблица `rag_chunks`)
- Чат API, возвращающий:
  - `answer`
  - `law`
  - `article`
  - `sources`

## Установка

```bash
npm install
cp .env.example .env
```

Заполните `GEMINI_API_KEY` в `.env`.
Также задайте `PG_URL` (или `DATABASE_URL`) для подключения к PostgreSQL.

Для PostgreSQL должен быть установлен extension:

```sql
CREATE EXTENSION IF NOT EXISTS vector;
```

## Запуск

```bash
npm run dev
```

## Тестовые пользователи

- `citizen / citizen123`
- `official / official123`

## API

### 1) Login

`POST /api/auth/login`

```json
{
  "username": "official",
  "password": "official123"
}
```

### 2) Ingestion документов (только official)

`POST /api/docs/ingest`

Индексация записывает чанки в PostgreSQL (`pgvector`), без использования большого локального `chunks.json`.

Header:

`Authorization: Bearer <token>`

### 3) Чат

`POST /api/chat`

Header:

`Authorization: Bearer <token>`

Body:

```json
{
  "message": "Меня остановили ДПС, что делать?",
  "mode": "citizen"
}
```

## Как готовить большой корпус документов (RU/KZ)

Используйте структуру:

- `data/docs/ru`
- `data/docs/kz`

Именование файлов:

`НазваниеЗакона__Статья.txt`

Пример:

- `KoAP_RK__797.txt`
- `Zakon_o_policii__54.txt`

Такое разбиение дает:

- языковую сегментацию (`ru`/`kz`)
- быстрый re-ingest частями
- прозрачные ссылки на закон и статью в ответе

## RAG-пайплайн и скорость ответа

Один вопрос `POST /api/chat` проходит через следующие шаги:

1. **NER**:
   - **Regex + юридический словарь** (`src/rag/ner.ts`) — мгновенно: статья, кодексы (КоАП, УК, УПК…), темы (драка, вред здоровью, ДПС…). Дополнительно функция **`enrichHarmSeverityLegalTerms`**: описания вроде «сломаю челюсть / перелом» автоматически добавляют в поиск термины по ст. **106–110 УК РК**, перечню тяжести вреда, судмедэкспертизе — чтобы пайплайн вытащил санкционные статьи, если они есть в БД.
   - **Нейросетевой NER из Hugging Face / Xenova** (`src/rag/neuralNer.ts`, пакет `@xenova/transformers`, модель по умолчанию `Xenova/bert-base-multilingual-cased-ner-hrl`) — находит именованные сущности (ORG, LOC, PER…), результат подмешивается в эмбеддинговый запрос. В dev включён по умолчанию; на **`NODE_ENV=production`** выключен (cold start и размер модели плохо дружат с serverless без кэша). Включить везде: `USE_TRANSFORMER_NER=1` в `.env`. Отключить локально: `USE_TRANSFORMER_NER=0`.
2. **Параллельный multi-query retrieval** (для PostgreSQL+pgvector):
   - параллельно эмбеддятся **исходный вопрос** и **NER-обогащённый запрос**;
   - результаты двух поисков объединяются через **Reciprocal Rank Fusion**;
   - если в вопросе явно есть номер статьи — статья достаётся из БД точечно (`fetchByArticle`) и добавляется к пулу;
   - если NER уверен в законе — подмешиваются чанки из соответствующего «семейства» (`fetchByLawLike`);
   - финальный список **бустится по NER** (нужная статья → нужный закон → остальное).
3. **Один объединённый LLM-вызов** (`selectAndGenerateAnswer`): модель за ОДИН проход и выбирает лучшие 1–4 фрагмента, и сразу пишет ответ. Раньше это делалось двумя вызовами и съедало ~10–15 секунд лишних.

**Опционально** можно вернуть LLM-расширение запроса (`RAG_LLM_QUERY_EXPAND=1`) — это добавляет ещё один эмбед-поиск, но ставит ещё один сетевой round-trip к Gemini.

### Ожидаемое время

- Эмбеддинги (2 параллельно) + PG поиск: ~1–2 с.
- Объединённый chat-вызов (выбор + ответ): ~12–20 с.
- Итого: **~15–25 секунд** против прежних 40–50.

На serverless (Vercel) к этому добавляется cold start (~1–3 с) и прогрев пула Postgres.

## Интеграция с law_front

Сейчас фронт использует `mockApi`. Чтобы перейти на backend:

1. В `law_front/src/lib/mockApi.ts` заменить вызов на fetch к `POST /api/chat`
2. Передавать JWT из login
3. Использовать уже готовые поля ответа `answer`, `law`, `article`
