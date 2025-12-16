"use client";

import { useState } from "react";
import { Document, Packer, Paragraph, HeadingLevel, ImageRun } from "docx";
import { saveAs } from "file-saver";
import Link from "next/link";

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

// Array shuffle
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

// -------------------------
// ✅ Image dimension parser (NO Blob/NO window/NO Image)
// Supports: PNG, JPEG, GIF, BMP
// -------------------------

function readU32BE(bytes: Uint8Array, offset: number) {
  return (
    (bytes[offset] << 24) |
    (bytes[offset + 1] << 16) |
    (bytes[offset + 2] << 8) |
    bytes[offset + 3]
  ) >>> 0;
}

function readU16BE(bytes: Uint8Array, offset: number) {
  return (bytes[offset] << 8) | bytes[offset + 1];
}

function readU16LE(bytes: Uint8Array, offset: number) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}

function readI32LE(bytes: Uint8Array, offset: number) {
  return (
    bytes[offset] |
    (bytes[offset + 1] << 8) |
    (bytes[offset + 2] << 16) |
    (bytes[offset + 3] << 24)
  );
}

function getImageDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (!bytes || bytes.length < 24) return null;

  // PNG signature: 89 50 4E 47 0D 0A 1A 0A
  const isPng =
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a;

  if (isPng && bytes.length >= 24) {
    // IHDR chunk starts at 8, width/height at 16..23
    const width = readU32BE(bytes, 16);
    const height = readU32BE(bytes, 20);
    if (width > 0 && height > 0) return { width, height };
  }

  // GIF: "GIF87a" or "GIF89a"
  const isGif =
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61;

  if (isGif && bytes.length >= 10) {
    const width = readU16LE(bytes, 6);
    const height = readU16LE(bytes, 8);
    if (width > 0 && height > 0) return { width, height };
  }

  // BMP: "BM"
  const isBmp = bytes[0] === 0x42 && bytes[1] === 0x4d;
  if (isBmp && bytes.length >= 26) {
    const width = readI32LE(bytes, 18);
    const height = Math.abs(readI32LE(bytes, 22));
    if (width > 0 && height > 0) return { width, height };
  }

  // JPEG: FF D8 ... segments ... SOF0/SOF2 contains width/height
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  if (isJpeg) {
    let offset = 2;

    while (offset < bytes.length) {
      // find marker 0xFF
      if (bytes[offset] !== 0xff) {
        offset++;
        continue;
      }

      // skip fill 0xFFs
      while (offset < bytes.length && bytes[offset] === 0xff) offset++;
      if (offset >= bytes.length) break;

      const marker = bytes[offset];
      offset++;

      // markers without length
      if (marker === 0xd9 /* EOI */ || marker === 0xda /* SOS */) break;

      if (offset + 1 >= bytes.length) break;
      const segmentLength = readU16BE(bytes, offset);
      if (segmentLength < 2) break;

      const segmentStart = offset + 2;

      // SOF markers: C0, C1, C2, C3, C5, C6, C7, C9, CA, CB, CD, CE, CF
      const isSOF =
        marker === 0xc0 ||
        marker === 0xc1 ||
        marker === 0xc2 ||
        marker === 0xc3 ||
        marker === 0xc5 ||
        marker === 0xc6 ||
        marker === 0xc7 ||
        marker === 0xc9 ||
        marker === 0xca ||
        marker === 0xcb ||
        marker === 0xcd ||
        marker === 0xce ||
        marker === 0xcf;

      if (isSOF) {
        // segment structure: [precision(1), height(2), width(2), ...]
        if (segmentStart + 4 < bytes.length) {
          const height = readU16BE(bytes, segmentStart + 1);
          const width = readU16BE(bytes, segmentStart + 3);
          if (width > 0 && height > 0) return { width, height };
        }
        break;
      }

      offset = offset + segmentLength;
    }
  }

  return null;
}

// ✅ Only-downscale: heç vaxt böyütmür
function clampToPage(
  size: { width: number; height: number },
  maxW: number,
  maxH: number
) {
  const scaleW = size.width > maxW ? maxW / size.width : 1;
  const scaleH = size.height > maxH ? maxH / size.height : 1;
  const scale = Math.min(scaleW, scaleH, 1);

  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}

// 🔹 1., 2), 3. kimi nömrələnmiş sualları "bir nömrədən növbəti nömrəyə qədər" bölən helper
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
      if (current.length) current.push(line);
      else current.push(line);
    }
  }

  if (current.length) {
    questions.push(current.join(" ").replace(/\s+/g, " ").trim());
  }

  if (!hasNumberPattern) {
    return lines.map((l) => l.trim()).filter(Boolean);
  }

  return questions.filter(Boolean);
}

// HTML → bloklara böl (I BLOK, II BLOK...) və içindəki sualları çıxar
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

    // OL/UL varsa
    if (el.tagName === "OL" || el.tagName === "UL") {
      const liElements = Array.from(el.children).filter(
        (child) => (child as HTMLElement).tagName === "LI"
      ) as HTMLElement[];

      liElements.forEach((li) => {
        const liText = (li.textContent || "").trim();
        const imgEls = Array.from(li.querySelectorAll("img"));

        const images: QuestionImage[] = [];
        imgEls.forEach((img) => {
          const src = img.getAttribute("src");
          if (!src) return;
          const qImg = dataUrlToImage(src);
          if (qImg) images.push(qImg);
        });

        if (!liText && images.length === 0) return;

        if (images.length > 0) {
          currentBlock!.questions.push({ text: liText, images });
        } else {
          const parts = splitNumberedQuestions(liText);
          parts.forEach((qText) => {
            currentBlock!.questions.push({ text: qText, images: [] });
          });
        }
      });

      continue;
    }

    // digər elementlər
    const imgEls = Array.from(el.querySelectorAll("img"));
    const hasText = !!text;

    const images: QuestionImage[] = [];
    imgEls.forEach((img) => {
      const src = img.getAttribute("src");
      if (!src) return;
      const qImg = dataUrlToImage(src);
      if (qImg) images.push(qImg);
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
      parts.forEach((qText) => {
        currentBlock!.questions.push({ text: qText, images: [] });
      });
    }
  }

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
  const [structureWarning, setStructureWarning] = useState<string | null>(null);

  // Form state
  const [university, setUniversity] = useState("Bakı Biznes Universiteti");
  const [faculty, setFaculty] = useState("");
  const [group, setGroup] = useState("");
  const [subject, setSubject] = useState("");
  const [headOfDept, setHeadOfDept] = useState("");
  const [author, setAuthor] = useState("");
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

          // ⚠️ Cədvəl / düstur warning
          const parser = new DOMParser();
          const dom = parser.parseFromString(html, "text/html");
          const hasTable = dom.querySelector("table") !== null;
          const hasMath = dom.querySelector("m\\:oMath, math") !== null;

          if (hasTable || hasMath) {
            setStructureWarning(
              "Bu faylda cədvəl və/və ya riyazi düstur aşkarlanıb. Zəhmət olmasa həmin hissələri Word-də şəkil (image) formasında əlavə edin ki, sistem biletə düzgün sala bilsin."
            );
          }

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
        const q = strictNoRepeat ? b.questions[i] : b.questions[i % b.questions.length];
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

    // Word səhifəsində rahatlıq üçün limitlər:
    const MAX_W = 520; // px
    const MAX_H = 720; // px

    const all: Paragraph[] = [];

    for (const ticket of tickets) {
      const arr: Paragraph[] = [];

      // Header
      arr.push(
        new Paragraph({
          text: university,
          heading: HeadingLevel.HEADING_2,
        })
      );

      arr.push(
        new Paragraph(`Fakültə: ${faculty || "________"}    Qrup: ${group || "________"}`)
      );

      arr.push(new Paragraph(`Fənn: ${subject || "________"}`));
      arr.push(new Paragraph(`Bilet № `));
      arr.push(new Paragraph(""));

      // Suallar
      for (let idx = 0; idx < ticket.questions.length; idx++) {
        const q = ticket.questions[idx].question;
        const prefix = `${idx + 1}. `;

        arr.push(
          new Paragraph({
            text: prefix + (q.text || ""),
          })
        );

        for (const img of q.images) {
          let type: "png" | "jpg" | "gif" | "bmp" = "png";
          if (img.contentType.includes("png")) type = "png";
          else if (img.contentType.includes("jpeg") || img.contentType.includes("jpg")) type = "jpg";
          else if (img.contentType.includes("gif")) type = "gif";
          else if (img.contentType.includes("bmp")) type = "bmp";

          // ✅ Orijinal ölçünü byte-dan oxu (yoxdursa fallback)
          const original = getImageDimensions(img.data) ?? { width: 420, height: 260 };

          // ✅ heç vaxt böyütmür, yalnız böyükdürsə kiçildir
          const size = clampToPage(original, MAX_W, MAX_H);

          arr.push(
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

        arr.push(new Paragraph(""));
      }

      // Footer signatures
      arr.push(new Paragraph(`Kafedra müdiri: ${headOfDept || "________________"}`));
      arr.push(new Paragraph(`Tərtib edən: ${author || "________________"}`));

      arr.push(new Paragraph(""));
      arr.push(new Paragraph(""));

      all.push(...arr);
    }

    const doc = new Document({
      sections: [
        {
          properties: {},
          children: all,
        },
      ],
    });

    const blob = await Packer.toBlob(doc);
    saveAs(blob, "biletler_shekilli.docx");
  };

  // =========================
  //          RENDER
  // =========================

  return (
    <main className="mx-auto max-w-6xl px-4 py-8">
      <header className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">
            DOCX → Şəkilli Bilet Generatoru
          </h1>
          <Link href="/blok" className="text-blue-500 hover:text-blue-600 text-sm">
            Nəzəri suallar üçün Blok-Blok əlavə etmək
          </Link>
          <p className="text-sm text-slate-600">
            DOCX yüklə → Sistem blokları (I BLOK, II BLOK...) və sualları (mətn + şəkil)
            avtomatik ayırsın → Biletləri generasiya edib DOCX olaraq yüklə.
          </p>
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
            <h2 className="mb-2 text-sm font-semibold text-slate-800">
              2. DOCX HTML görünüşü (mətn + şəkillər)
            </h2>
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
                  <input
                    value={university}
                    onChange={(e) => setUniversity(e.target.value)}
                    className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-600">Fakültə</label>
                  <input
                    value={faculty}
                    onChange={(e) => setFaculty(e.target.value)}
                    className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-600">Qrup</label>
                  <input
                    value={group}
                    onChange={(e) => setGroup(e.target.value)}
                    className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-600">Fənn</label>
                  <input
                    value={subject}
                    onChange={(e) => setSubject(e.target.value)}
                    className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-600">Kafedra müdiri</label>
                  <input
                    value={headOfDept}
                    onChange={(e) => setHeadOfDept(e.target.value)}
                    placeholder="Rahib İmamquluyev"
                    className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-600">Tərtib edən</label>
                  <input
                    value={author}
                    onChange={(e) => setAuthor(e.target.value)}
                    placeholder="Fərid Nəcəfov"
                    className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm outline-none focus:border-blue-500 focus:ring-1 focus:ring-blue-500"
                  />
                </div>

                <div className="space-y-1">
                  <label className="text-xs font-medium text-slate-600">Bilet sayı</label>
                  <input
                    type="number"
                    value={ticketCount}
                    min={1}
                    onChange={(e) => setTicketCount(Number(e.target.value))}
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
                  <label htmlFor="strict" className="text-xs text-slate-700">
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
                <div className="mb-1 text-xs text-slate-500">{university}</div>
                <div className="mb-1 text-xs text-slate-500">
                  Fakültə: {faculty || "________"} — Qrup: {group || "________"}
                </div>
                <div className="mb-1 text-xs text-slate-500">Fənn: {subject || "________"}</div>

                <div className="mb-2 font-semibold text-slate-800">Bilet № </div>

                <ol className="space-y-2 pl-4">
                  {t.questions.map((q, idx) => (
                    <li key={idx} className="text-sm text-slate-800">
                      {q.question.text && <div className="mb-1">{q.question.text}</div>}
                      {q.question.images.length > 0 && (
                        <div className="text-[11px] italic text-slate-500">
                          (Bu sualda şəkil var – DOCX faylında görünəcək)
                        </div>
                      )}
                    </li>
                  ))}
                </ol>

                <div className="mt-3 border-t border-slate-200 pt-2 text-[11px] text-slate-600">
                  <div>
                    Kafedra müdiri:{" "}
                    <span className="font-medium">{headOfDept || "________________"}</span>
                  </div>
                  <div>
                    Tərtib edən:{" "}
                    <span className="font-medium">{author || "________________"}</span>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {!parsed && !isLoading && (
        <p className="mt-4 text-sm text-slate-500">Başlamaq üçün yuxarıdan DOCX faylı seç.</p>
      )}
    </main>
  );
}