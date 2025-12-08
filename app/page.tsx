"use client";

import { useState } from "react";
import { saveAs } from "file-saver";
import { Document, Packer, Paragraph, HeadingLevel } from "docx";
import Link from "next/link";

type RawBlock = {
  name: string;
  text: string;
};

type Block = {
  name: string;
  questions: string[];
};

type TicketQuestion = {
  block: string;
  text: string;
};

type Ticket = {
  number: number;
  questions: TicketQuestion[];
};

function shuffle<T>(array: T[]): T[] {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// 🔹 1., 2), 3. kimi nömrələnmiş sualları "bir nömrədən növbəti nömrəyə qədər" bölən helper
function splitNumberedQuestions(text: string): string[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const questions: string[] = [];
  let current: string[] = [];
  let hasNumberPattern = false;

  const isNumbered = (line: string) => /^\s*\d+[\.\)]\s+/.test(line); // 1. , 2) və s.

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      if (current.length) current.push(""); // boş sətiri də sualın içində saxla
      continue;
    }

    if (isNumbered(line)) {
      hasNumberPattern = true;
      // yeni sual başlayır
      if (current.length) {
        questions.push(current.join(" ").replace(/\s+/g, " ").trim());
        current = [];
      }
      current.push(line);
    } else {
      // nömrə ilə başlamır → əvvəlki sualın davamı
      if (current.length) {
        current.push(line);
      } else {
        // heç sual açılmayıbsa, yenisini başlat
        current.push(line);
      }
    }
  }

  if (current.length) {
    questions.push(current.join(" ").replace(/\s+/g, " ").trim());
  }

  // ümumiyyətlə nömrələnmə tapılmadısa → fallback: hər sətir = 1 sual
  if (!hasNumberPattern) {
    return lines.map((l) => l.trim()).filter(Boolean);
  }

  return questions.filter(Boolean);
}

export default function HomePage() {
  const [university, setUniversity] = useState("Bakı Biznes Universiteti");
  const [subject, setSubject] = useState("");
  const [ticketCount, setTicketCount] = useState<number>(20);
  const [strictNoRepeat, setStrictNoRepeat] = useState(false); // true olsa: sual təkrarı əsla yoxdur

  const [blocks, setBlocks] = useState<RawBlock[]>([
    { name: "Blok 1", text: "" },
    { name: "Blok 2", text: "" },
    { name: "Blok 3", text: "" },
    { name: "Blok 4", text: "" },
    { name: "Blok 5", text: "" },
  ]);

  const [tickets, setTickets] = useState<Ticket[]>([]);

  const handleBlockNameChange = (index: number, value: string) => {
    setBlocks((prev) => {
      const copy = [...prev];
      copy[index] = { ...copy[index], name: value };
      return copy;
    });
  };

  const handleBlockTextChange = (index: number, value: string) => {
    setBlocks((prev) => {
      const copy = [...prev];
      copy[index] = { ...copy[index], text: value };
      return copy;
    });
  };

  const parseBlocks = (): Block[] => {
    return blocks.map((b, i) => ({
      name: (b.name || `Blok ${i + 1}`).trim(),
      // ƏVVƏL: hər sətir 1 sual idi
      // İNDİ: 1., 2) kimi nömrələnibsə → bir nömrədən növbəti nömrəyə qədər = 1 sual
      questions: splitNumberedQuestions(b.text),
    }));
  };

  const generateTickets = () => {
    if (!ticketCount || ticketCount <= 0) {
      alert("Bilet sayını düzgün daxil et.");
      return;
    }

    const parsed = parseBlocks();

    // Hər blokda ən azı 1 sual olmalıdır
    const emptyBlock = parsed.find((b) => b.questions.length === 0);
    if (emptyBlock) {
      alert(`${emptyBlock.name} üçün heç bir sual daxil edilməyib.`);
      return;
    }

    // Əgər strictNoRepeat → hər blokda sual sayı bilet sayından az ola bilməz
    if (strictNoRepeat) {
      const badBlock = parsed.find((b) => b.questions.length < ticketCount);
      if (badBlock) {
        alert(
          `${badBlock.name} blokunda kifayət qədər sual yoxdur.\n` +
            `Strict no-repeat rejimində ${ticketCount} bilet üçün ən azı ${ticketCount} sual lazımdır.`
        );
        return;
      }
    }

    // Hər blok üçün shuffle edirik ki, təkrar minimum olsun
    const shuffledByBlock = parsed.map((b) => ({
      name: b.name,
      questions: shuffle(b.questions),
    }));

    const newTickets: Ticket[] = [];

    for (let i = 0; i < ticketCount; i++) {
      const tQuestions: TicketQuestion[] = [];

      shuffledByBlock.forEach((b) => {
        let qText: string;

        if (strictNoRepeat) {
          qText = b.questions[i];
        } else {
          const idx = i % b.questions.length;
          qText = b.questions[idx];
        }

        tQuestions.push({
          block: b.name,
          text: qText,
        });
      });

      newTickets.push({
        number: i + 1,
        questions: tQuestions,
      });
    }

    setTickets(newTickets);
  };

  const exportToDocx = async () => {
    if (!tickets.length) {
      alert("Əvvəlcə biletləri generasiya et.");
      return;
    }

    const doc = new Document({
      sections: [
        {
          properties: {},
          children: tickets.flatMap((ticket) => {
            const header: Paragraph[] = [
              new Paragraph({
                text: university || "Universitet",
                heading: HeadingLevel.HEADING_2,
              }),
              new Paragraph({
                text: `Fənn: ${subject || "________"}`,
              }),
              new Paragraph({
                text: `Bilet № ${ticket.number}`,
              }),
              new Paragraph({ text: "" }),
            ];

            const body: Paragraph[] = ticket.questions.map((q, idx) => {
              return new Paragraph({
                text: `${idx + 1}. ${q.text}`,
              });
            });

            return [
              ...header,
              ...body,
              new Paragraph({ text: "" }),
              new Paragraph({ text: "" }),
            ];
          }),
        },
      ],
    });

    const blob = await Packer.toBlob(doc);
    saveAs(blob, "biletlər.docx");
  };

  return (
    <main
      style={{
        maxWidth: "960px",
        margin: "0 auto",
        padding: "24px",
        fontFamily: "system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
      }}
    >
      <h1 style={{ fontSize: "24px", fontWeight: 700, marginBottom: "16px" }}>
        İmtahan Bilet Generatoru (MVP)
      </h1>

      <div style={{ marginBottom: "16px" }}>
        <Link
          href="/fayl-oxuma"
              className="mt-4 inline-flex items-center justify-center rounded-md bg-blue-600 px-4 py-1.5 text-sm font-semibold text-white shadow-sm hover:bg-blue-700"
        >
          Fayl oxuma (DOCX test səhifəsi)
        </Link>
      </div>

      {/* Ümumi məlumatlar */}
      <section
        style={{
          border: "1px solid #ddd",
          borderRadius: "8px",
          padding: "16px",
          marginBottom: "16px",
        }}
      >
        <h2 style={{ fontSize: "18px", marginBottom: "12px" }}>Ümumi məlumat</h2>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr",
            gap: "12px",
            marginBottom: "12px",
          }}
        >
          <div>
            <label
              style={{
                fontSize: "14px",
                display: "block",
                marginBottom: "4px",
              }}
            >
              Universitet
            </label>
            <input
              type="text"
              value={university}
              onChange={(e) => setUniversity(e.target.value)}
              style={{
                width: "100%",
                padding: "8px",
                borderRadius: "4px",
                border: "1px solid #ccc",
              }}
            />
          </div>

          <div>
            <label
              style={{
                fontSize: "14px",
                display: "block",
                marginBottom: "4px",
              }}
            >
              Fənn
            </label>
            <input
              type="text"
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              placeholder="Məs: İKT, İngilis dili, Biologiya..."
              style={{
                width: "100%",
                padding: "8px",
                borderRadius: "4px",
                border: "1px solid #ccc",
              }}
            />
          </div>

          <div>
            <label
              style={{
                fontSize: "14px",
                display: "block",
                marginBottom: "4px",
              }}
            >
              Bilet sayı
            </label>
            <input
              type="number"
              min={1}
              value={ticketCount}
              onChange={(e) => setTicketCount(Number(e.target.value))}
              style={{
                width: "100%",
                padding: "8px",
                borderRadius: "4px",
                border: "1px solid #ccc",
              }}
            />
          </div>

          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "8px",
              marginTop: "20px",
            }}
          >
            <input
              id="strict-no-repeat"
              type="checkbox"
              checked={strictNoRepeat}
              onChange={(e) => setStrictNoRepeat(e.target.checked)}
            />
            <label htmlFor="strict-no-repeat" style={{ fontSize: "14px" }}>
              Sual təkrarı QƏTİ olmasın (hər blokda ən azı bilet sayı qədər sual
              olmalıdır)
            </label>
          </div>
        </div>
      </section>

      {/* Blok sualları */}
      <section
        style={{
          border: "1px solid #ddd",
          borderRadius: "8px",
          padding: "16px",
          marginBottom: "16px",
        }}
      >
        <h2 style={{ fontSize: "18px", marginBottom: "12px" }}>Bloklar və suallar</h2>

        <p style={{ fontSize: "13px", marginBottom: "8px", color: "#555" }}>
          Sən sualları istəsən birbaşa hər sətirə 1 sual kimi yaza bilərsən. Əgər
          sualları <strong>1., 2), 3.</strong> kimi nömrələsən, sistem bir
          nömrədən növbəti nömrəyə qədər olan hissəni <strong>1 sual</strong> kimi
          qəbul edəcək (multi-line suallar üçün ideal).
        </p>

        <div
          style={{ display: "flex", flexDirection: "column", gap: "12px" }}
        >
          {blocks.map((block, index) => (
            <div
              key={index}
              style={{
                border: "1px solid #eee",
                borderRadius: "6px",
                padding: "12px",
              }}
            >
              <div
                style={{
                  display: "flex",
                  gap: "8px",
                  marginBottom: "8px",
                }}
              >
                <input
                  type="text"
                  value={block.name}
                  onChange={(e) =>
                    handleBlockNameChange(index, e.target.value)
                  }
                  style={{
                    flex: 1,
                    padding: "6px 8px",
                    borderRadius: "4px",
                    border: "1px solid #ccc",
                    fontSize: "14px",
                  }}
                />
                <span style={{ fontSize: "13px", color: "#777" }}>
                  Blok {index + 1}
                </span>
              </div>

              <textarea
                value={block.text}
                onChange={(e) =>
                  handleBlockTextChange(index, e.target.value)
                }
                placeholder={`Buraya ${block.name} üçün sualları yazın.\n\nVariant 1: Hər sətir 1 sual.\nVariant 2: 1., 2), 3. ilə nömrələyin, sistem nömrədən nömrəyə qədər olan hissəni 1 sual kimi götürəcək.`}
                rows={6}
                style={{
                  width: "100%",
                  padding: "8px",
                  borderRadius: "4px",
                  border: "1px solid #ccc",
                  fontSize: "13px",
                  resize: "vertical",
                  fontFamily: "inherit",
                  whiteSpace: "pre-wrap",
                }}
              />
            </div>
          ))}
        </div>
      </section>

      {/* Action düymələri */}
      <section
        style={{
          marginBottom: "16px",
          display: "flex",
          gap: "12px",
        }}
      >
        <button
          onClick={generateTickets}
          style={{
            padding: "10px 16px",
            borderRadius: "6px",
            border: "none",
            backgroundColor: "#2563eb",
            color: "white",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Biletləri generasiya et
        </button>

        <button
          onClick={exportToDocx}
          style={{
            padding: "10px 16px",
            borderRadius: "6px",
            border: "1px solid #2563eb",
            backgroundColor: "white",
            color: "#2563eb",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          DOCX olaraq yüklə
        </button>
      </section>

      {/* Preview */}
      <section
        style={{
          border: "1px solid #ddd",
          borderRadius: "8px",
          padding: "16px",
          marginBottom: "32px",
        }}
      >
        <h2 style={{ fontSize: "18px", marginBottom: "12px" }}>
          Bilet ön-baxışı
        </h2>

        {!tickets.length && (
          <p style={{ fontSize: "14px", color: "#666" }}>
            Hələ bilet generasiya olunmayıb. Yuxarıda sualları daxil edib
            &quot;Biletləri generasiya et&quot; düyməsinə kliklə.
          </p>
        )}

        <div
          style={{ display: "flex", flexDirection: "column", gap: "16px" }}
        >
          {tickets.map((ticket) => (
            <div
              key={ticket.number}
              style={{
                border: "1px solid #eee",
                borderRadius: "6px",
                padding: "12px",
              }}
            >
              <div
                style={{
                  fontSize: "13px",
                  color: "#555",
                  marginBottom: "4px",
                }}
              >
                {university}
              </div>
              <div
                style={{
                  fontSize: "13px",
                  color: "#555",
                  marginBottom: "8px",
                }}
              >
                Fənn: {subject || "________"}
              </div>
              <div
                style={{
                  fontWeight: 600,
                  marginBottom: "8px",
                }}
              >
                Bilet № {ticket.number}
              </div>

              <ol style={{ paddingLeft: "20px", fontSize: "14px" }}>
                {ticket.questions.map((q, idx) => (
                  <li key={idx} style={{ marginBottom: "4px" }}>
                    {q.text}
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      </section>
    </main>
  );
}