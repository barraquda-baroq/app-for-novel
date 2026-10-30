// このファイルは npm --prefix connector run gen-schemas（scripts/gen-schemas.mjs）が src/mcp/schemas.ts から作る。手で直さない。
// zod の定義を JSON Schema（{ io: 'input' }）にしたもの。Workers の中で zod から作り直さないように、作った結果を置いておく。

export type ToolName =
  | 'novel_status'
  | 'novel_list_titles'
  | 'novel_get_outline'
  | 'novel_read_text'
  | 'novel_list_versions'
  | 'novel_search_text'
  | 'novel_get_notes'
  | 'novel_get_strategy'
  | 'novel_get_critique'
  | 'novel_list_proofreading'
  | 'novel_add_proofreading'
  | 'novel_add_revision_ideas'
  | 'novel_add_strategy_note'
  | 'novel_save_critique_prompt'
  | 'novel_add_critique_result'
  | 'novel_list_bench_works'
  | 'novel_get_bench_analysis'
  | 'novel_add_bench_analysis'

export const TOOL_SCHEMAS: Record<ToolName, Record<string, unknown>> = {
  "novel_status": {
    "type": "object",
    "properties": {}
  },
  "novel_list_titles": {
    "type": "object",
    "properties": {}
  },
  "novel_get_outline": {
    "type": "object",
    "properties": {
      "title_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "description": "タイトルの指し方（t:3f2a9c1b のような短い id・id・タイトル名）。novel_list_titles で確かめられる"
      },
      "chapter": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "description": "章だけにする（c:… の短い id か章の名前）"
      },
      "from": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "description": "範囲の最初の話（#1・p:…・「第1話」など。省略時は最初から）"
      },
      "to": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "description": "範囲の最後の話（含む。省略時は最後まで）"
      },
      "include_acts": {
        "default": true,
        "description": "幕に分けた話の幕の行も出す（既定 true）",
        "type": "boolean"
      },
      "response_format": {
        "default": "concise",
        "description": "concise = 要点だけ（既定）、detailed = 日付・理由なども出す",
        "type": "string",
        "enum": [
          "concise",
          "detailed"
        ]
      },
      "cursor": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4000,
        "description": "前の結果の最後にある 続き: cursor=\"…\" の値をそのまま渡す"
      }
    },
    "required": [
      "title_id"
    ]
  },
  "novel_read_text": {
    "type": "object",
    "properties": {
      "title_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "description": "タイトルの指し方（t:3f2a9c1b のような短い id・id・タイトル名）。novel_list_titles で確かめられる"
      },
      "chapter": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "description": "章だけにする（c:… の短い id か章の名前）"
      },
      "from": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "description": "範囲の最初の話（#1・p:…・「第1話」など。省略時は最初から）"
      },
      "to": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "description": "範囲の最後の話（含む。省略時は最後まで）"
      },
      "pieces": {
        "description": "読む話を並べて指定する（50件まで。幕も指せる）",
        "maxItems": 50,
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "話の指し方: #12（読む順）・#12.2（第12話の第2幕）・p:3f2a9c1b・「第12話」「第3話 第2幕」「プロローグ」"
        }
      },
      "version_id": {
        "description": "この稿だけを読む（v:… の短い id。採用していない稿も読める。novel_list_versions で確かめる）",
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "cursor": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4000,
        "description": "前の結果の最後にある 続き: cursor=\"…\" の値をそのまま渡す"
      },
      "char_budget": {
        "default": 20000,
        "description": "1回に返す文字数の目安（2,000〜60,000。既定 20,000。Claude Code では 12,000）",
        "type": "integer",
        "minimum": 2000,
        "maximum": 60000
      },
      "ruby": {
        "default": "raw",
        "description": "raw = ルビ・傍点の記法のまま（既定。推敲案の引用はこちらから）、strip = 記法と読みを除く（批評で読む時）",
        "type": "string",
        "enum": [
          "raw",
          "strip"
        ]
      }
    },
    "required": [
      "title_id"
    ]
  },
  "novel_list_versions": {
    "type": "object",
    "properties": {
      "title_id": {
        "description": "タイトル（#12・「第12話」で指す時は必要。p:… の短い id なら省略できる）",
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "piece": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "description": "話の指し方: #12（読む順）・#12.2（第12話の第2幕）・p:3f2a9c1b・「第12話」「第3話 第2幕」「プロローグ」"
      }
    },
    "required": [
      "piece"
    ]
  },
  "novel_search_text": {
    "type": "object",
    "properties": {
      "title_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "description": "タイトルの指し方（t:3f2a9c1b のような短い id・id・タイトル名）。novel_list_titles で確かめられる"
      },
      "query": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "description": "探す言葉（200字まで）。ルビの記法と読みを除いた本文で探す"
      },
      "mode": {
        "default": "literal",
        "description": "literal = そのまま（既定）、regex = 正規表現（JavaScript。^ と $ は各段落の頭と終わりに一致。. は改行に一致しない）",
        "type": "string",
        "enum": [
          "literal",
          "regex"
        ]
      },
      "scope": {
        "default": "adopted",
        "description": "adopted = 採用原稿（既定）、all_versions = すべての稿",
        "type": "string",
        "enum": [
          "adopted",
          "all_versions"
        ]
      },
      "from": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "description": "範囲の最初の話（#1・p:…・「第1話」など。省略時は最初から）"
      },
      "to": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "description": "範囲の最後の話（含む。省略時は最後まで）"
      },
      "context_chars": {
        "default": 25,
        "description": "一致の前後に出す文字数（既定 25）",
        "type": "integer",
        "minimum": 0,
        "maximum": 80
      },
      "max_hits": {
        "default": 40,
        "description": "1回に出す一致の数（既定 40）",
        "type": "integer",
        "minimum": 1,
        "maximum": 200
      },
      "count_only": {
        "default": false,
        "description": "true = 話ごとの件数だけ",
        "type": "boolean"
      },
      "cursor": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4000,
        "description": "前の結果の最後にある 続き: cursor=\"…\" の値をそのまま渡す"
      }
    },
    "required": [
      "title_id",
      "query"
    ]
  },
  "novel_get_notes": {
    "type": "object",
    "properties": {
      "title_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "description": "タイトルの指し方（t:3f2a9c1b のような短い id・id・タイトル名）。novel_list_titles で確かめられる"
      },
      "kind": {
        "type": "string",
        "enum": [
          "settings",
          "memos",
          "ideas"
        ],
        "description": "settings = 設定項目（キャラクター・世界観など）、memos = メモ、ideas = アイデア"
      },
      "ids": {
        "description": "本文まで読む項目（e:・m:・i: の短い id か名前）",
        "maxItems": 50,
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200
        }
      },
      "full": {
        "default": false,
        "description": "true = すべての本文を読む（char_budget まで）",
        "type": "boolean"
      },
      "char_budget": {
        "default": 20000,
        "description": "本文を返す文字数の上限（既定 20,000）",
        "type": "integer",
        "minimum": 2000,
        "maximum": 60000
      },
      "cursor": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4000,
        "description": "前の結果の最後にある 続き: cursor=\"…\" の値をそのまま渡す"
      }
    },
    "required": [
      "title_id",
      "kind"
    ]
  },
  "novel_get_strategy": {
    "type": "object",
    "properties": {
      "title_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "description": "タイトルの指し方（t:3f2a9c1b のような短い id・id・タイトル名）。novel_list_titles で確かめられる"
      },
      "submission_id": {
        "description": "この応募計画（o:…）を詳しく",
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "note_id": {
        "description": "この戦略メモ（g:…）を全文で",
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "revision_idea_id": {
        "description": "この改稿案（r:…）を全文で",
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "section": {
        "description": "overall = 全体戦略（タイトルのメモ）を全文で",
        "type": "string",
        "enum": [
          "overall"
        ]
      },
      "char_budget": {
        "description": "1つを全文で読む時に1回に返す文字数（2,000〜60,000。既定 60,000、Claude Code では 12,000。残りは 続き: cursor=\"…\"）",
        "type": "integer",
        "minimum": 2000,
        "maximum": 60000
      },
      "cursor": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4000,
        "description": "前の結果の最後にある 続き: cursor=\"…\" の値をそのまま渡す"
      }
    },
    "required": [
      "title_id"
    ]
  },
  "novel_get_critique": {
    "type": "object",
    "properties": {
      "title_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "description": "タイトルの指し方（t:3f2a9c1b のような短い id・id・タイトル名）。novel_list_titles で確かめられる"
      },
      "prompt_id": {
        "description": "この批評プロンプト（q:…）を全文で",
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "result_id": {
        "description": "この批評の結果（a:…）を全文で",
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "char_budget": {
        "description": "1つを全文で読む時に1回に返す文字数（2,000〜60,000。既定 60,000、Claude Code では 12,000。残りは 続き: cursor=\"…\"）",
        "type": "integer",
        "minimum": 2000,
        "maximum": 60000
      },
      "cursor": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4000,
        "description": "前の結果の最後にある 続き: cursor=\"…\" の値をそのまま渡す"
      }
    },
    "required": [
      "title_id"
    ]
  },
  "novel_list_proofreading": {
    "type": "object",
    "properties": {
      "title_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "description": "タイトルの指し方（t:3f2a9c1b のような短い id・id・タイトル名）。novel_list_titles で確かめられる"
      },
      "status": {
        "default": "open",
        "description": "open = チェックしていない案（既定）、done = チェックした案、all = すべて",
        "type": "string",
        "enum": [
          "open",
          "done",
          "all"
        ]
      },
      "category": {
        "description": "種類だけにする（typo=誤字脱字・変換ミス, ra_nuki=ら抜き, i_nuki=い抜き, cliche=既成表現, tic=作者の癖, repetition=近接重複, notation=表記ゆれ, symbols=記号の作法, ruby=ルビ・傍点の記法, grammar=文法・係り受け, other=その他）",
        "type": "string",
        "enum": [
          "typo",
          "ra_nuki",
          "i_nuki",
          "cliche",
          "tic",
          "repetition",
          "notation",
          "symbols",
          "ruby",
          "grammar",
          "other"
        ]
      },
      "from": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "description": "範囲の最初の話（#1・p:…・「第1話」など。省略時は最初から）"
      },
      "to": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "description": "範囲の最後の話（含む。省略時は最後まで）"
      },
      "run_id": {
        "description": "この実行（ワードサーチ）の案だけ",
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "response_format": {
        "default": "concise",
        "description": "concise = 要点だけ（既定）、detailed = 日付・理由なども出す",
        "type": "string",
        "enum": [
          "concise",
          "detailed"
        ]
      },
      "cursor": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4000,
        "description": "前の結果の最後にある 続き: cursor=\"…\" の値をそのまま渡す"
      }
    },
    "required": [
      "title_id"
    ]
  },
  "novel_add_proofreading": {
    "type": "object",
    "properties": {
      "title_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "description": "タイトルの指し方（t:3f2a9c1b のような短い id・id・タイトル名）。novel_list_titles で確かめられる"
      },
      "run_label": {
        "description": "一連の推敲の名前（例: ワードサーチ（第1〜20話））",
        "type": "string",
        "maxLength": 60
      },
      "run_date": {
        "type": "string",
        "maxLength": 10,
        "description": "YYYY-MM-DD（日本時間）。省略時は今日"
      },
      "covered": {
        "description": "確認し終えた話（推敲案が無かった話も入れる。#12・p:…）",
        "maxItems": 200,
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "話の指し方: #12（読む順）・#12.2（第12話の第2幕）・p:3f2a9c1b・「第12話」「第3話 第2幕」「プロローグ」"
        }
      },
      "items": {
        "maxItems": 100,
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "piece": {
              "type": "string",
              "minLength": 1,
              "maxLength": 200,
              "description": "話の指し方: #12（読む順）・#12.2（第12話の第2幕）・p:3f2a9c1b・「第12話」「第3話 第2幕」「プロローグ」"
            },
            "excerpt": {
              "type": "string",
              "minLength": 1,
              "maxLength": 100,
              "description": "その話・幕の採用原稿から原文どおりに引用した箇所（ルビの記法も含める。100字以内）"
            },
            "context_before": {
              "description": "同じ箇所が何度もある時に区別する、引用の直前の文字（30字以内）",
              "type": "string",
              "maxLength": 30
            },
            "category": {
              "type": "string",
              "enum": [
                "typo",
                "ra_nuki",
                "i_nuki",
                "cliche",
                "tic",
                "repetition",
                "notation",
                "symbols",
                "ruby",
                "grammar",
                "other"
              ],
              "description": "typo=誤字脱字・変換ミス, ra_nuki=ら抜き, i_nuki=い抜き, cliche=既成表現, tic=作者の癖, repetition=近接重複, notation=表記ゆれ, symbols=記号の作法, ruby=ルビ・傍点の記法, grammar=文法・係り受け, other=その他"
            },
            "category_label": {
              "description": "種類の表示名（other の時の名前など）",
              "type": "string",
              "maxLength": 20
            },
            "suggestion": {
              "description": "直し案（無ければ空）",
              "type": "string",
              "maxLength": 500
            },
            "reason": {
              "type": "string",
              "minLength": 1,
              "maxLength": 300,
              "description": "短い説明"
            },
            "important": {
              "default": false,
              "description": "true = 重要（アプリでフラグを立てて最上位に出す）",
              "type": "boolean"
            }
          },
          "required": [
            "piece",
            "excerpt",
            "category",
            "reason"
          ]
        },
        "description": "推敲案（1回100件まで）"
      },
      "model": {
        "type": "string",
        "maxLength": 60,
        "description": "使ったモデルの名前（任意）"
      }
    },
    "required": [
      "title_id",
      "items"
    ]
  },
  "novel_add_revision_ideas": {
    "type": "object",
    "properties": {
      "title_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "description": "タイトルの指し方（t:3f2a9c1b のような短い id・id・タイトル名）。novel_list_titles で確かめられる"
      },
      "items": {
        "maxItems": 20,
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "heading": {
              "type": "string",
              "minLength": 1,
              "maxLength": 80,
              "description": "改稿案の見出し（80字以内）"
            },
            "body": {
              "type": "string",
              "minLength": 1,
              "description": "改稿案の本文（ワンシーン丸ごとでもよい。長さの上限なし）"
            },
            "pieces": {
              "description": "関係する話（#12・p:…）",
              "maxItems": 50,
              "type": "array",
              "items": {
                "type": "string",
                "minLength": 1,
                "maxLength": 200,
                "description": "話の指し方: #12（読む順）・#12.2（第12話の第2幕）・p:3f2a9c1b・「第12話」「第3話 第2幕」「プロローグ」"
              }
            }
          },
          "required": [
            "heading",
            "body"
          ]
        },
        "description": "改稿案（1回20件まで）"
      }
    },
    "required": [
      "title_id",
      "items"
    ]
  },
  "novel_add_strategy_note": {
    "type": "object",
    "properties": {
      "title_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "description": "タイトルの指し方（t:3f2a9c1b のような短い id・id・タイトル名）。novel_list_titles で確かめられる"
      },
      "heading": {
        "type": "string",
        "minLength": 1,
        "maxLength": 80,
        "description": "戦略メモの見出し（80字以内）"
      },
      "body": {
        "type": "string",
        "minLength": 1,
        "description": "本文（Markdown。長さの上限なし）"
      },
      "run_date": {
        "type": "string",
        "maxLength": 10,
        "description": "YYYY-MM-DD（日本時間）。省略時は今日"
      },
      "contests": {
        "description": "狙うコンテストの候補（10件まで）。アプリで「応募計画にする」を押すと応募計画になる",
        "maxItems": 10,
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "name": {
              "type": "string",
              "minLength": 1,
              "maxLength": 80,
              "description": "コンテスト・賞の名前"
            },
            "organizer": {
              "description": "主催",
              "type": "string",
              "maxLength": 80
            },
            "url": {
              "description": "募集要項の URL（https）",
              "type": "string",
              "maxLength": 2000
            },
            "deadline": {
              "description": "締切（YYYY-MM-DD）",
              "type": "string",
              "maxLength": 10
            },
            "limit": {
              "description": "規定の長さ",
              "type": "object",
              "properties": {
                "min": {
                  "description": "下限",
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "max": {
                  "description": "上限",
                  "type": "integer",
                  "minimum": 0,
                  "maximum": 9007199254740991
                },
                "unit": {
                  "description": "chars = 文字数、pages = 400字詰め原稿用紙の枚数",
                  "type": "string",
                  "enum": [
                    "chars",
                    "pages"
                  ]
                }
              }
            },
            "fit": {
              "description": "このタイトルとの相性",
              "type": "string"
            },
            "plan": {
              "description": "応募までの改稿の方針",
              "type": "string"
            }
          },
          "required": [
            "name"
          ]
        }
      },
      "model": {
        "type": "string",
        "maxLength": 60,
        "description": "使ったモデルの名前（任意）"
      }
    },
    "required": [
      "title_id",
      "heading",
      "body"
    ]
  },
  "novel_save_critique_prompt": {
    "type": "object",
    "properties": {
      "title_id": {
        "description": "scope が title の時のタイトル",
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "scope": {
        "type": "string",
        "enum": [
          "title",
          "shared"
        ],
        "description": "title = このタイトルの批評プロンプト、shared = どのタイトルでも使う共通のもの"
      },
      "name": {
        "type": "string",
        "minLength": 1,
        "maxLength": 60,
        "description": "プロンプトの名前（60字以内）"
      },
      "body": {
        "type": "string",
        "minLength": 1,
        "description": "プロンプトの本文（長さの上限なし）"
      }
    },
    "required": [
      "scope",
      "name",
      "body"
    ]
  },
  "novel_add_critique_result": {
    "type": "object",
    "properties": {
      "title_id": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "description": "タイトルの指し方（t:3f2a9c1b のような短い id・id・タイトル名）。novel_list_titles で確かめられる"
      },
      "prompt_id": {
        "description": "使った批評プロンプト（q:… か名前）",
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "prompt_text": {
        "description": "実際に使ったプロンプト（省略時は prompt_id の本文）",
        "type": "string"
      },
      "result_markdown": {
        "description": "批評の結果（Markdown。長さの上限なし。1件の記録に入らない時は、ツールの答えのとおりに分けて記録する）",
        "type": "string"
      },
      "artifact_url": {
        "description": "結果のアーティファクトの URL（https）",
        "type": "string",
        "maxLength": 2000
      },
      "run_date": {
        "type": "string",
        "maxLength": 10,
        "description": "YYYY-MM-DD（日本時間）。省略時は今日"
      },
      "scope": {
        "description": "批評した範囲（省略時はタイトル全体）",
        "type": "object",
        "properties": {
          "from": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "description": "話の指し方: #12（読む順）・#12.2（第12話の第2幕）・p:3f2a9c1b・「第12話」「第3話 第2幕」「プロローグ」"
          },
          "to": {
            "type": "string",
            "minLength": 1,
            "maxLength": 200,
            "description": "話の指し方: #12（読む順）・#12.2（第12話の第2幕）・p:3f2a9c1b・「第12話」「第3話 第2幕」「プロローグ」"
          }
        },
        "required": [
          "from",
          "to"
        ]
      },
      "model": {
        "type": "string",
        "maxLength": 60,
        "description": "使ったモデルの名前（任意）"
      },
      "bench_works": {
        "description": "批評の中で比べた相対比較の作品（w:… か作品名。20件まで）。アプリの批評の結果に「比べた作品」として出る",
        "maxItems": 20,
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 200,
          "description": "相対比較の作品の指し方（w:3f2a9c1b のような短い id・id・作品名そのもの）。novel_list_bench_works で確かめられる"
        }
      }
    },
    "required": [
      "title_id"
    ]
  },
  "novel_list_bench_works": {
    "type": "object",
    "properties": {}
  },
  "novel_get_bench_analysis": {
    "type": "object",
    "properties": {
      "work": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "description": "相対比較の作品の指し方（w:3f2a9c1b のような短い id・id・作品名そのもの）。novel_list_bench_works で確かめられる"
      },
      "viewpoints": {
        "description": "この観点の分析だけを読む（構成・文体など。省略時はすべての観点）",
        "maxItems": 20,
        "type": "array",
        "items": {
          "type": "string",
          "minLength": 1,
          "maxLength": 40
        }
      },
      "analysis_id": {
        "description": "この分析（n:…）だけを読む",
        "type": "string",
        "minLength": 1,
        "maxLength": 200
      },
      "char_budget": {
        "description": "1つを全文で読む時に1回に返す文字数（2,000〜60,000。既定 60,000、Claude Code では 12,000。残りは 続き: cursor=\"…\"）",
        "type": "integer",
        "minimum": 2000,
        "maximum": 60000
      },
      "cursor": {
        "type": "string",
        "minLength": 1,
        "maxLength": 4000,
        "description": "前の結果の最後にある 続き: cursor=\"…\" の値をそのまま渡す"
      }
    },
    "required": [
      "work"
    ]
  },
  "novel_add_bench_analysis": {
    "type": "object",
    "properties": {
      "work": {
        "type": "string",
        "minLength": 1,
        "maxLength": 200,
        "description": "分析する作品（w:… か作品名）。相対比較にまだ無い作品は new_work も付ける"
      },
      "new_work": {
        "description": "作品が相対比較に無い時だけ作る作品（付けた時だけ作る。同じ作品名・著者の作品があればそれに足す（著者が違えば別の作品として作る））",
        "type": "object",
        "properties": {
          "name": {
            "type": "string",
            "minLength": 1,
            "maxLength": 80,
            "description": "作品名（80字以内）"
          },
          "author": {
            "type": "string",
            "maxLength": 80,
            "description": "著者（80字以内）"
          },
          "publisher": {
            "description": "出版社",
            "type": "string",
            "maxLength": 80
          },
          "year": {
            "description": "刊行年",
            "type": "string",
            "maxLength": 20
          },
          "genre": {
            "description": "ジャンル",
            "type": "string",
            "maxLength": 40
          },
          "pdf_place": {
            "description": "PDF の置き場所（claude.ai のプロジェクト名など）",
            "type": "string",
            "maxLength": 200
          }
        },
        "required": [
          "name",
          "author"
        ]
      },
      "items": {
        "minItems": 1,
        "maxItems": 20,
        "type": "array",
        "items": {
          "type": "object",
          "properties": {
            "viewpoint": {
              "type": "string",
              "minLength": 1,
              "maxLength": 40,
              "description": "観点の名前（構成・文体・人物・冒頭の掴みなど。40字以内）"
            },
            "body_markdown": {
              "type": "string",
              "minLength": 1,
              "description": "その観点の分析（Markdown。長さの上限なし）"
            },
            "run_date": {
              "type": "string",
              "maxLength": 10,
              "description": "YYYY-MM-DD（日本時間）。省略時は今日"
            }
          },
          "required": [
            "viewpoint",
            "body_markdown"
          ]
        },
        "description": "分析（観点ごとに1つ。1回20件まで）"
      },
      "model": {
        "type": "string",
        "maxLength": 60,
        "description": "使ったモデルの名前（任意）"
      }
    },
    "required": [
      "work",
      "items"
    ]
  }
}

export const WRITE_OUTPUT_SCHEMA: Record<string, unknown> = {
  "type": "object",
  "properties": {
    "created": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "id": {
            "type": "string"
          },
          "label": {
            "type": "string"
          }
        },
        "required": [
          "id",
          "label"
        ]
      }
    },
    "skipped": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "index": {
            "type": "integer",
            "minimum": -9007199254740991,
            "maximum": 9007199254740991
          },
          "reason": {
            "type": "string"
          },
          "hint": {
            "type": "string"
          }
        },
        "required": [
          "index",
          "reason"
        ]
      }
    }
  },
  "required": [
    "created",
    "skipped"
  ]
}
