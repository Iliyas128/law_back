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
  - локальное хранилище в `data/db/chunks.json`
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

## Интеграция с law_front

Сейчас фронт использует `mockApi`. Чтобы перейти на backend:

1. В `law_front/src/lib/mockApi.ts` заменить вызов на fetch к `POST /api/chat`
2. Передавать JWT из login
3. Использовать уже готовые поля ответа `answer`, `law`, `article`
