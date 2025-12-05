"use client";

import { useState } from "react";
import {
  Document,
  Packer,
  Paragraph,
  HeadingLevel,
  ImageRun,
} from "docx";
import { saveAs } from "file-saver";

// =========================
//         TYPE-LƏR
// =========================

type QuestionImage = {
  contentType: string; // image/png, image/jpeg...
  data: Uint8Array;
};

type Question = {
  text: string;
  images: QuestionImage[];
};

type Block = {
  name: string;
  questions: Question[];
};

type TicketQuestion = {
  block: string;
  question: Question;
};

type Ticket = {
  number: number;
  questions: TicketQuestion[];
};

type ParsedResult = {
  html: string;
};

// =========================
//    HELPER FUNCTIONS
// =========================

function shuffle<T>(array: T[]): T[] {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// data:image/...;base64,... → Uint8Array + MIME
function dataUrlToImage(dataUrl: string): QuestionImage | null {
  if (!dataUrl.startsWith("data:")) return null;

  const [meta, base64] = dataUrl.split(",");
  if (!base64) return null;

  const match = meta.match(/^data:(.*);base64$/);
  const contentType = match?.[1] ?? "image/png";

  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);

  for (let i = 0; i < len; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  return { contentType, data: bytes };
}

// HTML → bloklara böl
function parseBlocksFromHtml(html: string): Block[] {
   const parser = new DOMParser();
   const doc = parser.parseFromString(html, "text/html");
 
   const blocks: Block[] = [];
   let currentBlock: Block | null = null;
 
   const blockRegex = /^(I|II|III|IV|V)\s*BLOK/i;
 
   // Body-nin birbaşa child elementlərini gəzək (p, ol, table və s.)
   const elements = Array.from(doc.body.children);
 
   for (const el of elements) {
     const text = (el.textContent || "").trim();
 
     // 1) BLOK başlıqları (I BLOK, II BLOK...)
     const isBlockHeader = text && blockRegex.test(text);
     if (isBlockHeader) {
       currentBlock = {
         name: text,
         questions: [],
       };
       blocks.push(currentBlock);
       continue;
     }
 
     // Hələ blok başlamayıbsa, bu elementi atlayırıq
     if (!currentBlock) continue;
 
     // 2) Əgər element OL/UL-dursa → hər <li> ayrıca sual olsun
     if (el.tagName === "OL" || el.tagName === "UL") {
       const liElements = Array.from(el.children).filter(
         (child) => (child as HTMLElement).tagName === "LI"
       ) as HTMLElement[];
 
       liElements.forEach((li) => {
         const liText = (li.textContent || "").trim();
         const imgEls = Array.from(li.querySelectorAll("img"));
 
         if (!liText && imgEls.length === 0) return; // boş li
 
         const images: QuestionImage[] = [];
         imgEls.forEach((img) => {
           const src = img.getAttribute("src");
           if (!src) return;
           const qImg = dataUrlToImage(src);
           if (qImg) images.push(qImg);
         });
 
         currentBlock!.questions.push({
           text: liText,
           images,
         });
       });
 
       // bu elementi artıq işlədik, davam
       continue;
     }
 
     // 3) Digər elementlər (p, div, table və s.) → əvvəlki kimi 1 sual
     const imgEls = Array.from(el.querySelectorAll("img"));
     if (!text && imgEls.length === 0) continue;
 
     const images: QuestionImage[] = [];
     imgEls.forEach((img) => {
       const src = img.getAttribute("src");
       if (!src) return;
       const qImg = dataUrlToImage(src);
       if (qImg) images.push(qImg);
     });
 
     currentBlock.questions.push({
       text,
       images,
     });
   }
 
   // sualı olmayan blokları atırıq
   return blocks.filter((b) => b.questions.length > 0);
 }
// =========================
//      MAIN COMPONENT
// =========================

export default function FaylOxumaPage() {
  const [parsed, setParsed] = useState<ParsedResult | null>(null);
  const [blocks, setBlocks] = useState<Block[]>([]);
  const [tickets, setTickets] = useState<Ticket[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Form state
  const [university, setUniversity] = useState("Bakı Biznes Universiteti");
  const [subject, setSubject] = useState("");
  const [ticketCount, setTicketCount] = useState(20);
  const [strictNoRepeat, setStrictNoRepeat] = useState(false);

  // =========================
  //       DOCX LOAD
  // =========================

  const handleFileChange = async (file: File | null) => {
    if (!file) return;

    setParsed(null);
    setBlocks([]);
    setTickets([]);
    setErrorMsg(null);
    setIsLoading(true);

    try {
      const reader = new FileReader();

      reader.onload = async (e) => {
        try {
          const arrayBuf = e.target?.result;
          if (!(arrayBuf instanceof ArrayBuffer)) {
            setErrorMsg("Fayl oxunmadı.");
            setIsLoading(false);
            return;
          }

          const mammoth = await import("mammoth/mammoth.browser");

          const htmlResult = await mammoth.convertToHtml({
            arrayBuffer: arrayBuf,
          });

          const html = htmlResult.value;

          setParsed({ html });

          const parsedBlocks = parseBlocksFromHtml(html);
          setBlocks(parsedBlocks);
        } catch (err) {
          console.error(err);
          setErrorMsg("DOCX oxunarkən xəta baş verdi.");
        } finally {
          setIsLoading(false);
        }
      };

      reader.readAsArrayBuffer(file);
    } catch (err) {
      console.error(err);
      setErrorMsg("Fayl oxuma zamanı xəta.");
      setIsLoading(false);
    }
  };

  // =========================
  //     BİLET GENERATORU
  // =========================

  const generateTicketsFromDoc = () => {
    if (!blocks.length) {
      alert("Əvvəlcə DOCX faylı yüklə.");
      return;
    }

    if (!ticketCount || ticketCount < 1) {
      alert("Bilet sayı düzgün deyil.");
      return;
    }

    if (strictNoRepeat) {
      const bad = blocks.find((b) => b.questions.length < ticketCount);
      if (bad) {
        alert(`${bad.name} blokunda kifayət qədər sual yoxdur.`);
        return;
      }
    }

    const shuffled = blocks.map((b) => ({
      name: b.name,
      questions: shuffle(b.questions),
    }));

    const newTickets: Ticket[] = [];

    for (let i = 0; i < ticketCount; i++) {
      const tQ: TicketQuestion[] = [];

      shuffled.forEach((b) => {
        const q =
          strictNoRepeat ? b.questions[i] : b.questions[i % b.questions.length];

        tQ.push({ block: b.name, question: q });
      });

      newTickets.push({
        number: i + 1,
        questions: tQ,
      });
    }

    setTickets(newTickets);
  };

  // =========================
  //        DOCX EXPORT
  // =========================

  const exportTicketsToDocx = async () => {
    if (!tickets.length) {
      alert("Əvvəlcə bilet generasiya et.");
      return;
    }

    const sections = [
      {
        properties: {},
        children: tickets.flatMap((ticket) => {
          const arr: Paragraph[] = [];

          // Header
          arr.push(
            new Paragraph({
              text: university,
              heading: HeadingLevel.HEADING_2,
            })
          );
          arr.push(new Paragraph(`Fənn: ${subject || "________"}`));
          arr.push(new Paragraph(`Bilet № ${ticket.number}`));
          arr.push(new Paragraph(""));

          // Suallar
          ticket.questions.forEach((tq, idx) => {
            const q = tq.question;
            const prefix = `${idx + 1}. `;

            arr.push(
              new Paragraph({
                text: prefix + (q.text || ""),
              })
            );

            q.images.forEach((img) => {
              let type: "png" | "jpg" | "gif" | "bmp" = "png";

              if (img.contentType.includes("png")) {
                type = "png";
              } else if (
                img.contentType.includes("jpeg") ||
                img.contentType.includes("jpg")
              ) {
                type = "jpg";
              } else if (img.contentType.includes("gif")) {
                type = "gif";
              } else if (img.contentType.includes("bmp")) {
                type = "bmp";
              }

              arr.push(
                new Paragraph({
                  children: [
                    new ImageRun({
                      data: img.data,
                      type,
                      transformation: {
                        width: 420,
                        height: 260,
                      },
                    }),
                  ],
                })
              );
            });

            arr.push(new Paragraph(""));
          });

          arr.push(new Paragraph(""));
          arr.push(new Paragraph(""));

          return arr;
        }),
      },
    ];

    const doc = new Document({ sections });
    const blob = await Packer.toBlob(doc);
    saveAs(blob, "biletler_shekilli.docx");
  };

  // =========================
  //          RENDER
  // =========================

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      {/* Başlıq */}
      <header className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">
            DOCX → Şəkilli Bilet Generatoru
          </h1>
          <p className="text-sm text-slate-600">
            DOCX yüklə → Sistem blokları (I BLOK, II BLOK...) və sualları (mətn
            + şəkil) avtomatik ayırsın → Biletləri generasiya edib DOCX olaraq
            yüklə.
          </p>
        </div>
      </header>

      {/* Fayl seçimi kartı */}
      <section className="mb-6 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="mb-2 text-sm font-semibold text-slate-800">1. DOCX faylını yüklə</h2>
        <p className="mb-3 text-xs text-slate-500">
          Faylda blok başlıqları <strong>I BLOK, II BLOK, ...</strong> formasında
          olmalıdır. Hər blokun altında praktiki suallar (mətn + şəkil) ola bilər.
        </p>

        <input
          type="file"
          accept=".doc,.docx"
          onChange={(e) => handleFileChange(e.target.files?.[0] || null)}
          className="text-sm file:mr-3 file:rounded-md file:border-0 file:bg-blue-600 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-blue-700"
        />

        {isLoading && (
          <p className="mt-2 text-sm text-slate-600">Fayl oxunur...</p>
        )}
        {errorMsg && (
          <p className="mt-2 text-sm text-red-600">{errorMsg}</p>
        )}
      </section>

      {/* HTML preview + blok info + parametrlər */}
      {parsed && (
        <section className="mb-6 grid gap-4 lg:grid-cols-[1.2fr,0.8fr]">
          {/* HTML preview */}
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 shadow-sm">
            <h2 className="mb-2 text-sm font-semibold text-slate-800">
              2. DOCX HTML görünüşü (mətn + şəkillər)
            </h2>
            <div className="max-h-[420px] overflow-auto rounded-lg border border-slate-200 bg-white p-3 text-sm">
              <div
                dangerouslySetInnerHTML={{ __html: parsed.html }}
                className="[&_*]:max-w-full"
              />
            </div>
          </div>

          {/* Bloklar + parametrlər + generate düyməsi */}
          <div className="flex flex-col gap-3">
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h2 className="mb-2 text-sm font-semibold text-slate-800">
                3. Tapılan bloklar
              </h2>
              {blocks.length === 0 ? (
                <p className="text-xs text-slate-500">
                  Blok tapılmadı. DOCX faylında{" "}
                  <code className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px]">
                    I BLOK
                  </code>
                  ,{" "}
                  <code className="rounded bg-slate-100 px-1.5 py-0.5 text-[11px]">
                    II BLOK
                  </code>{" "}
                  və s. başlıqlar olduğuna əmin ol.
                </p>
              ) : (
                <ul className="space-y-1 text-sm text-slate-700">
                  {blocks.map((b, idx) => (
                    <li key={idx} className="flex items-center justify-between">
                      <span>{b.name}</span>
                      <span className="text-xs text-slate-500">
                        {b.questions.length} sual
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h2 className="mb-2 text-sm font-semibold text-slate-800">
                4. Bilet parametrləri
              </h2>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-600">
                    Universitet
                  </label>
                  <input
                    value={university}
                    onChange={(e) => setUniversity(e.target.value)}
                    className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-600">
                    Fənn
                  </label>
                  <input
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                    placeholder="Məs: İKT, İngilis dili..."
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-600">
                    Bilet sayı
                  </label>
                  <input
                    type="number"
                    value={ticketCount}
                    min={1}
                    onChange={(e) =>
                      setTicketCount(Number(e.target.value))
                    }
                    className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  />
                </div>

                <div className="flex items-center gap-2 pt-5">
                  <input
                    id="strict"
                    type="checkbox"
                    checked={strictNoRepeat}
                    onChange={(e) => setStrictNoRepeat(e.target.checked)}
                    className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                  />
                  <label
                    htmlFor="strict"
                    className="text-xs text-slate-700"
                  >
                    Sual təkrarı <span className="font-semibold">olmasın</span>
                  </label>
                </div>
              </div>

              <button
                onClick={generateTicketsFromDoc}
                disabled={!blocks.length}
                className="mt-4 inline-flex items-center justify-center rounded-md bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-400"
              >
                Biletləri generasiya et
              </button>
            </div>
          </div>
        </section>
      )}

      {/* Bilet preview + DOCX export */}
      {tickets.length > 0 && (
        <section className="mt-6 space-y-4 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <h2 className="text-sm font-semibold text-slate-800">
              5. Generasiya olunmuş biletlər ({tickets.length} ədəd)
            </h2>

            <button
              onClick={exportTicketsToDocx}
              className="inline-flex items-center justify-center rounded-md border border-blue-600 px-4 py-1.5 text-sm font-semibold text-blue-600 hover:bg-blue-50"
            >
              DOCX olaraq yüklə
            </button>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            {tickets.map((t) => (
              <div
                key={t.number}
                className="rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm"
              >
                <div className="mb-1 text-xs text-slate-500">
                  {university} — Fənn: {subject || "________"}
                </div>
                <div className="mb-2 font-semibold text-slate-800">
                  Bilet № {t.number}
                </div>
                <ol className="space-y-2 pl-4">
                  {t.questions.map((q, idx) => (
                    <li key={idx} className="text-sm text-slate-800">
                      {q.question.text && (
                        <div className="mb-1">{q.question.text}</div>
                      )}
                      {q.question.images.length > 0 && (
                        <div className="text-[11px] italic text-slate-500">
                          (Bu sualda şəkil var – DOCX faylında görünəcək)
                        </div>
                      )}
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        </section>
      )}

      {!parsed && !isLoading && (
        <p className="mt-4 text-sm text-slate-500">
          Başlamaq üçün yuxarıdan DOCX faylı seç.
        </p>
      )}
    </main>
  );
}