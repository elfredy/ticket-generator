"use client";

import { useState } from "react";
import {
  Document,
  Packer,
  Paragraph,
  HeadingLevel,
  ImageRun,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  TextRun,
  BorderStyle,
} from "docx";
import { saveAs } from "file-saver";
import Link from "next/link";

// =========================
//         TYPE-LƏR
// =========================

type QuestionImage = {
  contentType: string;
  data: Uint8Array;
  width?: number;  // px
  height?: number; // px
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

function dataUrlToImage(dataUrl: string): { contentType: string; data: Uint8Array } | null {
  if (!dataUrl.startsWith("data:")) return null;

  const [meta, base64] = dataUrl.split(",");
  if (!base64) return null;

  const match = meta.match(/^data:(.*);base64$/);
  const contentType = match?.[1] ?? "image/png";

  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);

  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);

  return { contentType, data: bytes };
}

// img tag-dan ölçü oxu (width/height attr və ya style)
function readImgSize(img: HTMLImageElement): { width?: number; height?: number } {
  const wAttr = img.getAttribute("width");
  const hAttr = img.getAttribute("height");

  const w1 = wAttr ? Number(wAttr) : undefined;
  const h1 = hAttr ? Number(hAttr) : undefined;

  // style="width:123px; height:45px"
  const style = img.getAttribute("style") || "";
  const wMatch = style.match(/width\s*:\s*(\d+)\s*px/i);
  const hMatch = style.match(/height\s*:\s*(\d+)\s*px/i);
  const w2 = wMatch ? Number(wMatch[1]) : undefined;
  const h2 = hMatch ? Number(hMatch[1]) : undefined;

  return {
    width: Number.isFinite(w1) && w1 ? w1 : Number.isFinite(w2) ? w2 : undefined,
    height: Number.isFinite(h1) && h1 ? h1 : Number.isFinite(h2) ? h2 : undefined,
  };
}

// yalnız böyükdürsə kiçildir (böyütmür)
function fitToMaxWidth(size: { width: number; height: number }, maxWidth: number) {
  if (size.width <= maxWidth) return size;
  const ratio = maxWidth / size.width;
  return {
    width: Math.round(size.width * ratio),
    height: Math.round(size.height * ratio),
  };
}

function splitNumberedQuestions(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const questions: string[] = [];
  let current: string[] = [];
  let hasNumberPattern = false;

  const isNumbered = (line: string) => /^\s*\d+[\.\)]\s+/.test(line);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (current.length) current.push("");
      continue;
    }

    if (isNumbered(line)) {
      hasNumberPattern = true;
      if (current.length) {
        questions.push(current.join(" ").replace(/\s+/g, " ").trim());
        current = [];
      }
      current.push(line);
    } else {
      current.push(line);
    }
  }

  if (current.length) {
    questions.push(current.join(" ").replace(/\s+/g, " ").trim());
  }

  if (!hasNumberPattern) return lines.map((l) => l.trim()).filter(Boolean);

  return questions.filter(Boolean);
}

function parseBlocksFromHtml(html: string): Block[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(html, "text/html");

  const blocks: Block[] = [];
  let currentBlock: Block | null = null;

  const blockRegex = /^(I|II|III|IV|V)\s*BLOK/i;
  const elements = Array.from(doc.body.children);

  for (const el of elements) {
    const text = (el.textContent || "").trim();

    const isBlockHeader = text && blockRegex.test(text);
    if (isBlockHeader) {
      currentBlock = { name: text, questions: [] };
      blocks.push(currentBlock);
      continue;
    }

    if (!currentBlock) continue;

    // OL / UL
    if (el.tagName === "OL" || el.tagName === "UL") {
      const liElements = Array.from(el.children).filter(
        (child) => (child as HTMLElement).tagName === "LI"
      ) as HTMLElement[];

      liElements.forEach((li) => {
        const liText = (li.textContent || "").trim();
        const imgEls = Array.from(li.querySelectorAll("img")) as HTMLImageElement[];

        const images: QuestionImage[] = [];
        imgEls.forEach((img) => {
          const src = img.getAttribute("src");
          if (!src) return;
          const qImg = dataUrlToImage(src);
          if (!qImg) return;

          const { width, height } = readImgSize(img);
          images.push({ ...qImg, width, height });
        });

        if (!liText && images.length === 0) return;

        if (images.length > 0) {
          currentBlock!.questions.push({ text: liText, images });
        } else {
          const parts = splitNumberedQuestions(liText);
          parts.forEach((qText) => currentBlock!.questions.push({ text: qText, images: [] }));
        }
      });

      continue;
    }

    // digər elementlər
    const imgEls = Array.from(el.querySelectorAll("img")) as HTMLImageElement[];
    const hasText = !!text;

    const images: QuestionImage[] = [];
    imgEls.forEach((img) => {
      const src = img.getAttribute("src");
      if (!src) return;
      const qImg = dataUrlToImage(src);
      if (!qImg) return;

      const { width, height } = readImgSize(img);
      images.push({ ...qImg, width, height });
    });

    const hasImages = images.length > 0;

    // yalnız şəkil → son sualın üzərinə əlavə et
    if (!hasText && hasImages) {
      if (currentBlock.questions.length > 0) {
        const lastQ = currentBlock.questions[currentBlock.questions.length - 1];
        lastQ.images = [...lastQ.images, ...images];
      } else {
        currentBlock.questions.push({ text: "", images });
      }
      continue;
    }

    // həm mətn, həm şəkil
    if (hasText && hasImages) {
      currentBlock.questions.push({ text, images });
      continue;
    }

    // yalnız mətn
    if (hasText && !hasImages) {
      const parts = splitNumberedQuestions(text);
      parts.forEach((qText) => currentBlock!.questions.push({ text: qText, images: [] }));
    }
  }

  return blocks.filter((b) => b.questions.length > 0);
}

// =========================
//      DOCX UI HELPERS
// =========================

const noBorders = {
  top: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
  bottom: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
  left: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
  right: { style: BorderStyle.NONE, size: 0, color: "FFFFFF" },
};

function labelLine(label: string, value?: string) {
  return new Paragraph({
    children: [
      new TextRun({ text: `${label}: ` }),
      new TextRun({ text: value?.trim() ? value.trim() : "____________", bold: true }),
    ],
  });
}

function imgTypeFromMime(mime: string): "png" | "jpg" | "gif" | "bmp" {
  const m = (mime || "").toLowerCase();
  if (m.includes("png")) return "png";
  if (m.includes("jpeg") || m.includes("jpg")) return "jpg";
  if (m.includes("gif")) return "gif";
  if (m.includes("bmp")) return "bmp";
  return "png";
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
  const [structureWarning, setStructureWarning] = useState<string | null>(null);

  // Form state
  const [university, setUniversity] = useState("Bakı Biznes Universiteti");
  const [subject, setSubject] = useState("");
  const [faculty, setFaculty] = useState("");
  const [group, setGroup] = useState("");

  const [teacher, setTeacher] = useState("");
  const [department, setDepartment] = useState("");
  const [examDate, setExamDate] = useState("");

  const [headOfDept, setHeadOfDept] = useState("");
  const [author, setAuthor] = useState("");

  const [ticketCount, setTicketCount] = useState(20);
  const [strictNoRepeat, setStrictNoRepeat] = useState(false);

  const handleFileChange = async (file: File | null) => {
    if (!file) return;

    setParsed(null);
    setBlocks([]);
    setTickets([]);
    setErrorMsg(null);
    setStructureWarning(null);
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
          const htmlResult = await mammoth.convertToHtml({ arrayBuffer: arrayBuf });
          const html = htmlResult.value;

          setParsed({ html });

          const parser = new DOMParser();
          const dom = parser.parseFromString(html, "text/html");
          const hasTable = dom.querySelector("table") !== null;
          const hasMath = dom.querySelector("m\\:oMath, math") !== null;

          if (hasTable || hasMath) {
            setStructureWarning(
              "Bu faylda cədvəl və/və ya riyazi düstur aşkarlanıb. Zəhmət olmasa həmin hissələri Word-də şəkil (image) formasında əlavə edin ki, sistem biletə düzgün sala bilsin."
            );
          }

          setBlocks(parseBlocksFromHtml(html));
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

  const generateTicketsFromDoc = () => {
    if (!blocks.length) return alert("Əvvəlcə DOCX faylı yüklə.");
    if (!ticketCount || ticketCount < 1) return alert("Bilet sayı düzgün deyil.");

    if (strictNoRepeat) {
      const bad = blocks.find((b) => b.questions.length < ticketCount);
      if (bad) return alert(`${bad.name} blokunda kifayət qədər sual yoxdur.`);
    }

    const shuffled = blocks.map((b) => ({ name: b.name, questions: shuffle(b.questions) }));
    const newTickets: Ticket[] = [];

    for (let i = 0; i < ticketCount; i++) {
      const tQ: TicketQuestion[] = [];
      shuffled.forEach((b) => {
        const q = strictNoRepeat ? b.questions[i] : b.questions[i % b.questions.length];
        tQ.push({ block: b.name, question: q });
      });

      newTickets.push({ number: i + 1, questions: tQ });
    }

    setTickets(newTickets);
  };

  const exportTicketsToDocx = async () => {
    if (!tickets.length) return alert("Əvvəlcə bilet generasiya et.");

    const MAX_W = 520;

    const all: (Paragraph | Table)[] = [];

    for (const ticket of tickets) {
      all.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: university || "Universitet", bold: true, size: 28 })],
        })
      );

      all.push(new Paragraph({ text: "" }));

      all.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({
              children: [
                new TableCell({
                  borders: noBorders,
                  width: { size: 50, type: WidthType.PERCENTAGE },
                  children: [labelLine("Fənin adı", subject)],
                }),
                new TableCell({
                  borders: noBorders,
                  width: { size: 50, type: WidthType.PERCENTAGE },
                  children: [labelLine("Fakültə", faculty)],
                }),
              ],
            }),
            new TableRow({
              children: [
                new TableCell({ borders: noBorders, children: [labelLine("Fənn Müəllimi", teacher)] }),
                new TableCell({ borders: noBorders, children: [labelLine("Qrup", group)] }),
              ],
            }),
          ],
        })
      );

      all.push(new Paragraph({ text: "" }));

      all.push(
        new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [
            new TextRun({ text: "BİLET №", bold: true, size: 26 }),
            new TextRun({ text: ` ${ticket.number}`, bold: true, size: 26 }),
          ],
        })
      );

      all.push(new Paragraph({ text: "" }));
      all.push(new Paragraph({ text: "" }));

      for (let idx = 0; idx < ticket.questions.length; idx++) {
        const q = ticket.questions[idx].question;

        all.push(
          new Paragraph({
            children: [
              new TextRun({ text: `${idx + 1}. `, bold: true }),
              new TextRun({ text: q.text || "" }),
            ],
          })
        );

        for (const img of q.images) {
          const type = imgTypeFromMime(img.contentType);

          // ✅ orijinal ölçü (HTML-dən gəlir). yoxdursa fallback.
          let size = {
            width: img.width && img.width > 0 ? img.width : 420,
            height: img.height && img.height > 0 ? img.height : 260,
          };

          // ✅ yalnız böyükdürsə kiçilt
          size = fitToMaxWidth(size, MAX_W);

          all.push(
            new Paragraph({
              children: [
                new ImageRun({
                  data: img.data,
                  type,
                  transformation: {
                    width: size.width,
                    height: size.height,
                  },
                }),
              ],
            })
          );
        }

        all.push(new Paragraph({ text: "" }));
      }

      all.push(new Paragraph({ text: "" }));

      all.push(
        new Paragraph({
          children: [
            new TextRun({ text: "İmtahan bileti " }),
            new TextRun({ text: examDate?.trim() ? examDate.trim() : "____________", bold: true }),
            new TextRun({ text: " tarixində " }),
            new TextRun({ text: department?.trim() ? department.trim() : "____________", bold: true }),
            new TextRun({
              text: " kafedrası tərəfindən təqdim edilən müvafiq fənn üzrə imtahan sualları bloku əsasında hazırlanmışdır",
            }),
          ],
        })
      );

      all.push(new Paragraph({ text: "" }));
      all.push(new Paragraph({ text: "" }));

      all.push(
        new Table({
          width: { size: 100, type: WidthType.PERCENTAGE },
          rows: [
            new TableRow({
              children: [
                new TableCell({
                  borders: noBorders,
                  width: { size: 50, type: WidthType.PERCENTAGE },
                  children: [
                    new Paragraph({
                      children: [
                        new TextRun({ text: "Kafedra müdiri: " }),
                        new TextRun({
                          text: headOfDept?.trim() ? headOfDept.trim() : "______________",
                          bold: true,
                        }),
                      ],
                    }),
                  ],
                }),
                new TableCell({
                  borders: noBorders,
                  width: { size: 50, type: WidthType.PERCENTAGE },
                  children: [
                    new Paragraph({
                      children: [
                        new TextRun({ text: "Tərtib etdi: " }),
                        new TextRun({ text: author?.trim() ? author.trim() : "________________", bold: true }),
                      ],
                    }),
                  ],
                }),
              ],
            }),
          ],
        })
      );

      all.push(new Paragraph({ text: "" }));
      all.push(new Paragraph({ text: "" }));
      all.push(new Paragraph({ text: "" }));
    }

    const doc = new Document({
      sections: [{ properties: {}, children: all }],
    });

    const out = await Packer.toBlob(doc);
    saveAs(out, "biletler_template_format.docx");
  };

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <header className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">DOCX → Şəkilli Bilet Generatoru</h1>
          <Link href="/blok" className="text-blue-500 hover:text-blue-600 text-sm">
            Nəzəri suallar üçün Blok-Blok əlavə etmək
          </Link>
        </div>
      </header>

      <section className="mb-6 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="mb-2 text-sm font-semibold text-slate-800">1. DOCX faylını yüklə</h2>
        <input
          type="file"
          accept=".doc,.docx"
          onChange={(e) => handleFileChange(e.target.files?.[0] || null)}
          className="text-sm file:mr-3 file:rounded-md file:border-0 file:bg-blue-600 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white hover:file:bg-blue-700"
        />
        {isLoading && <p className="mt-2 text-sm text-slate-600">Fayl oxunur...</p>}
        {errorMsg && <p className="mt-2 text-sm text-red-600">{errorMsg}</p>}
        {structureWarning && (
          <div className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            {structureWarning}
          </div>
        )}
      </section>

      {parsed && (
        <section className="mb-6 grid gap-4 lg:grid-cols-[1.2fr,0.8fr]">
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 shadow-sm">
            <h2 className="mb-2 text-sm font-semibold text-slate-800">2. DOCX HTML görünüşü</h2>
            <div className="max-h-[420px] overflow-auto rounded-lg border border-slate-200 bg-white p-3 text-sm">
              <div dangerouslySetInnerHTML={{ __html: parsed.html }} className="[&_*]:max-w-full" />
            </div>
          </div>

          <div className="flex flex-col gap-3">
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h2 className="mb-2 text-sm font-semibold text-slate-800">3. Tapılan bloklar</h2>
              {blocks.length === 0 ? (
                <p className="text-xs text-slate-500">Blok tapılmadı.</p>
              ) : (
                <ul className="space-y-1 text-sm text-slate-700">
                  {blocks.map((b, idx) => (
                    <li key={idx} className="flex items-center justify-between">
                      <span>{b.name}</span>
                      <span className="text-xs text-slate-500">{b.questions.length} sual</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>

            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <h2 className="mb-2 text-sm font-semibold text-slate-800">4. Bilet parametrləri</h2>

              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-600">Universitet</label>
                  <input value={university} onChange={(e) => setUniversity(e.target.value)} className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500" />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-600">Fənin adı</label>
                  <input value={subject} onChange={(e) => setSubject(e.target.value)} className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500" />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-600">Fakültə</label>
                  <input value={faculty} onChange={(e) => setFaculty(e.target.value)} className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500" />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-600">Qrup</label>
                  <input value={group} onChange={(e) => setGroup(e.target.value)} className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500" />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-600">Fənn müəllimi</label>
                  <input placeholder="Nəcəfov Fərid" value={teacher} onChange={(e) => setTeacher(e.target.value)} className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500" />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-600">Tarix</label>
                  <input value={examDate} onChange={(e) => setExamDate(e.target.value)} className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500" />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-600">Kafedra adı</label>
                  <input value={department} placeholder="İT kafedra" onChange={(e) => setDepartment(e.target.value)} className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500" />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-600">Kafedra müdiri</label>
                  <input value={headOfDept} placeholder="Rahib İmamquluyev" onChange={(e) => setHeadOfDept(e.target.value)} className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500" />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-600">Tərtib edən</label>
                  <input value={author} onChange={(e) => setAuthor(e.target.value)} className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500" />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-600">Bilet sayı</label>
                  <input type="number" value={ticketCount} min={1} onChange={(e) => setTicketCount(Number(e.target.value))} className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500" />
                </div>

                <div className="flex items-center gap-2 pt-5">
                  <input id="strict" type="checkbox" checked={strictNoRepeat} onChange={(e) => setStrictNoRepeat(e.target.checked)} className="h-4 w-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
                  <label htmlFor="strict" className="text-xs text-slate-700">
                    Sual təkrarı <span className="font-semibold">olmasın</span>
                  </label>
                </div>
              </div>

              <button onClick={generateTicketsFromDoc} disabled={!blocks.length} className="mt-4 inline-flex items-center justify-center rounded-md bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-400">
                Biletləri generasiya et
              </button>

              <button onClick={exportTicketsToDocx} disabled={!tickets.length} className="mt-3 inline-flex w-full items-center justify-center rounded-md border border-blue-600 px-4 py-1.5 text-sm font-semibold text-blue-600 hover:bg-blue-50 disabled:cursor-not-allowed disabled:opacity-60">
                DOCX olaraq yüklə (Template format)
              </button>
            </div>
          </div>
        </section>
      )}

      {!parsed && !isLoading && (
        <p className="mt-4 text-sm text-slate-500">Başlamaq üçün yuxarıdan DOCX faylı seç.</p>
      )}
    </main>
  );
}