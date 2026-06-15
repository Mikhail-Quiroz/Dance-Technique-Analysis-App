"""CSS theme injection for the retro zine aesthetic."""

THEMES = {
    "Diary Pink": {
        "paper":        "#F5E6E0",
        "surface":      "#FBEFF2",
        "accent":       "#E8568F",
        "accent_deep":  "#C2266B",
        "ink":          "#2E2B33",
        "dark_section": "#41454F",
    },
}

_GRAIN_SVG = (
    "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='200' height='200'%3E"
    "%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.75' "
    "numOctaves='4' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E"
    "%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.4'/%3E"
    "%3C/svg%3E"
)

def css(theme_name: str = "Diary Pink") -> str:
    t = THEMES.get(theme_name, THEMES["Diary Pink"])
    return f"""
<style>
@import url('https://fonts.googleapis.com/css2?family=Ultra&family=Anton&family=Yellowtail&family=Special+Elite&family=Space+Grotesk:wght@300;400;500;600;700&display=swap');

:root {{
    --paper:        {t['paper']};
    --surface:      {t['surface']};
    --accent:       {t['accent']};
    --accent-deep:  {t['accent_deep']};
    --ink:          {t['ink']};
    --dark-section: {t['dark_section']};
}}

/* ── Base ─────────────────────────────────────────── */
.stApp {{
    background-color: var(--paper) !important;
    font-family: 'Space Grotesk', sans-serif !important;
    color: var(--ink) !important;
}}

/* Paper grain fixed overlay */
.stApp::after {{
    content: '';
    position: fixed;
    inset: 0;
    background-image: url("{_GRAIN_SVG}");
    background-repeat: repeat;
    opacity: 0.045;
    pointer-events: none;
    z-index: 99999;
    mix-blend-mode: multiply;
}}

/* ── Sidebar ──────────────────────────────────────── */
[data-testid="stSidebar"] {{
    background-color: var(--dark-section) !important;
    color: #f0f0f0 !important;
}}
[data-testid="stSidebar"] * {{
    color: #f0f0f0 !important;
    font-family: 'Special Elite', monospace !important;
}}
[data-testid="stSidebar"] h1,
[data-testid="stSidebar"] h2,
[data-testid="stSidebar"] h3 {{
    color: var(--accent) !important;
    font-family: 'Anton', sans-serif !important;
    letter-spacing: 0.05em;
    text-transform: uppercase;
}}

/* ── Buttons ──────────────────────────────────────── */
.stButton > button {{
    background-color: var(--accent) !important;
    color: #fff !important;
    border: 2px solid var(--ink) !important;
    box-shadow: 3px 3px 0 var(--ink) !important;
    font-family: 'Anton', sans-serif !important;
    text-transform: uppercase !important;
    letter-spacing: 0.08em !important;
    border-radius: 2px !important;
    padding: 0.45rem 1.1rem !important;
    transition: transform 0.12s ease, box-shadow 0.12s ease !important;
}}
.stButton > button:hover {{
    transform: rotate(-1.5deg) translateY(-1px) !important;
    box-shadow: 4px 5px 0 var(--ink) !important;
}}
.stButton > button:active {{
    transform: rotate(0deg) translateY(1px) !important;
    box-shadow: 1px 1px 0 var(--ink) !important;
}}

/* Secondary buttons (download) */
[data-testid="stDownloadButton"] > button {{
    background-color: var(--surface) !important;
    color: var(--ink) !important;
    border: 2px solid var(--ink) !important;
    box-shadow: 3px 3px 0 var(--ink) !important;
    font-family: 'Anton', sans-serif !important;
    border-radius: 2px !important;
    text-transform: uppercase !important;
}}

/* ── Text inputs ──────────────────────────────────── */
.stTextInput > div > div > input,
.stTextArea > div > div > textarea {{
    background-color: var(--surface) !important;
    border: 2px solid var(--ink) !important;
    border-radius: 2px !important;
    font-family: 'Special Elite', monospace !important;
    color: var(--ink) !important;
    box-shadow: 2px 2px 0 var(--ink);
}}

/* ── Selectbox / data editor ──────────────────────── */
[data-testid="stSelectbox"] > div > div {{
    background-color: var(--surface) !important;
    border: 2px solid var(--ink) !important;
    border-radius: 2px !important;
    font-family: 'Special Elite', monospace !important;
}}

/* ── Progress bar ─────────────────────────────────── */
[data-testid="stProgressBar"] > div {{
    background-color: var(--surface) !important;
    border: 2px solid var(--ink) !important;
    border-radius: 2px !important;
    box-shadow: 2px 2px 0 var(--ink);
    height: 18px !important;
}}
[data-testid="stProgressBar"] > div > div {{
    background-color: var(--accent) !important;
    border-radius: 0 !important;
}}

/* ── Expanders ────────────────────────────────────── */
[data-testid="stExpander"] {{
    border: 2px solid var(--ink) !important;
    border-radius: 2px !important;
    background-color: var(--surface) !important;
    box-shadow: 2px 2px 0 var(--ink);
}}
[data-testid="stExpander"] summary {{
    font-family: 'Anton', sans-serif !important;
    text-transform: uppercase !important;
    letter-spacing: 0.05em !important;
}}

/* ── Dataframes / tables ──────────────────────────── */
[data-testid="stDataFrame"] {{
    border: 2px solid var(--ink) !important;
    box-shadow: 2px 2px 0 var(--ink);
}}

/* ── Dividers ─────────────────────────────────────── */
hr {{
    border: none !important;
    border-top: 2px solid var(--ink) !important;
    opacity: 0.3 !important;
}}

/* ── Success / info / warning banners ────────────── */
[data-testid="stAlert"] {{
    border-radius: 2px !important;
    border: 2px solid var(--ink) !important;
    font-family: 'Special Elite', monospace !important;
}}

/* ── Video ────────────────────────────────────────── */
[data-testid="stVideo"] video,
.stVideo video {{
    border: 3px solid var(--ink) !important;
    box-shadow: 5px 5px 0 var(--ink) !important;
    border-radius: 2px !important;
}}

/* ── Headings ─────────────────────────────────────── */
h1 {{
    font-family: 'Ultra', serif !important;
    text-transform: uppercase !important;
    color: var(--ink) !important;
    letter-spacing: 0.02em;
}}
h2 {{
    font-family: 'Anton', sans-serif !important;
    text-transform: uppercase !important;
    letter-spacing: 0.05em;
    color: var(--ink) !important;
}}
h3 {{
    font-family: 'Anton', sans-serif !important;
    letter-spacing: 0.03em;
    color: var(--accent-deep) !important;
}}

/* ── Metric tiles ─────────────────────────────────── */
[data-testid="stMetric"] {{
    background-color: var(--surface) !important;
    border: 2px solid var(--ink) !important;
    box-shadow: 3px 3px 0 var(--ink) !important;
    padding: 0.75rem 1rem !important;
    border-radius: 2px !important;
    /* Never clip any content — height grows with text */
    overflow: visible !important;
    height: auto !important;
    min-height: unset !important;
}}
[data-testid="stMetricLabel"] {{
    font-family: 'Special Elite', monospace !important;
    text-transform: uppercase !important;
    font-size: 0.7rem !important;
    letter-spacing: 0.1em !important;
}}
[data-testid="stMetricValue"] {{
    font-family: 'Ultra', serif !important;
    color: var(--accent-deep) !important;
    /* Responsive size — shrinks on long cues, never truncates */
    font-size: clamp(0.72rem, 1.4vw, 1.1rem) !important;
    white-space: normal !important;
    word-break: break-word !important;
    overflow-wrap: break-word !important;
    overflow: visible !important;
    text-overflow: clip !important;
    line-height: 1.35 !important;
    height: auto !important;
    min-height: unset !important;
}}
/* Override every nested wrapper Streamlit adds inside the metric */
[data-testid="stMetricValue"] * {{
    overflow: visible !important;
    white-space: normal !important;
    word-break: break-word !important;
    overflow-wrap: break-word !important;
    height: auto !important;
    min-height: unset !important;
    text-overflow: clip !important;
}}
[data-testid="stMetric"] > div,
[data-testid="stMetric"] > div > div {{
    overflow: visible !important;
    height: auto !important;
}}

/* ── Custom zine components ───────────────────────── */
.zine-header {{
    background-color: var(--dark-section);
    background-image: radial-gradient(circle, rgba(255,255,255,0.08) 1px, transparent 1.3px);
    background-size: 6px 6px;
    padding: 1.5rem 2rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1.5rem;
    border-bottom: 3px solid var(--accent);
}}
.zine-header .session-num {{
    font-family: 'Special Elite', monospace;
    color: rgba(255,255,255,0.6);
    font-size: 0.75rem;
    letter-spacing: 0.2em;
    text-transform: uppercase;
}}
.zine-header .app-name {{
    font-family: 'Ultra', serif;
    color: #fff;
    text-transform: uppercase;
    font-size: 1.4rem;
    letter-spacing: 0.06em;
    background: transparent;
    border: 2px solid rgba(255,255,255,0.5);
    border-radius: 9999px;
    padding: 0.2rem 1.2rem;
}}
.zine-header .header-date {{
    font-family: 'Special Elite', monospace;
    color: rgba(255,255,255,0.6);
    font-size: 0.75rem;
    letter-spacing: 0.1em;
}}

.session-card {{
    background-color: var(--surface);
    border: 2px solid var(--ink);
    box-shadow: 4px 4px 0 var(--ink);
    border-radius: 2px;
    overflow: hidden;
    margin-bottom: 1rem;
    position: relative;
    transition: transform 0.15s ease, box-shadow 0.15s ease;
}}
.session-card:hover {{
    transform: translateY(-2px);
    box-shadow: 6px 6px 0 var(--ink);
}}
.session-card-thumb {{
    width: 100%;
    aspect-ratio: 4/3;
    object-fit: cover;
    display: block;
    border-bottom: 2px solid var(--ink);
}}
.session-card-body {{
    padding: 0.6rem 0.75rem;
}}
.card-title {{
    font-family: 'Anton', sans-serif;
    font-size: 0.95rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--ink);
    margin: 0 0 0.2rem 0;
    line-height: 1.2;
}}
.card-date {{
    font-family: 'Special Elite', monospace;
    font-size: 0.7rem;
    color: var(--ink);
    opacity: 0.65;
    margin: 0;
}}
.score-sticker {{
    position: absolute;
    top: 0.5rem;
    right: 0.5rem;
    background-color: var(--accent);
    color: #fff;
    font-family: 'Special Elite', monospace;
    font-size: 0.7rem;
    padding: 0.15rem 0.4rem;
    border: 1.5px solid var(--ink);
    box-shadow: 2px 2px 0 var(--ink);
    transform: rotate(2deg);
    white-space: nowrap;
}}

.cue-card {{
    background-color: var(--surface);
    border: 1.5px solid var(--ink);
    box-shadow: 3px 4px 0 rgba(46,43,51,0.35);
    /* NO clip-path and NO rotation on the container — border must stay fully visible */
    padding: 0.8rem 1rem;
    margin-bottom: 0.9rem;
}}
.cue-chip {{
    display: inline-block;
    background-color: var(--accent);
    color: #fff;
    font-family: 'Anton', sans-serif;
    font-size: 0.85rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    padding: 0.1rem 0.5rem;
    border: 1.5px solid var(--ink);
    margin-bottom: 0.4rem;
    transform: rotate(-1deg);  /* slant stays on the title chip only */
}}
.cue-why {{
    font-family: 'Space Grotesk', sans-serif;
    font-size: 0.82rem;
    color: var(--ink);
    margin: 0.3rem 0;
    line-height: 1.5;
    text-align: left;
}}
.cue-drill {{
    font-family: 'Space Grotesk', sans-serif;
    font-size: 0.82rem;
    color: var(--ink);
    margin: 0.3rem 0;
    line-height: 1.5;
    text-align: left;
}}
.cue-drill::before {{
    content: 'DRILL: ';
    font-family: 'Special Elite', monospace;
    font-weight: bold;
    color: var(--accent-deep);
}}

.empty-state {{
    text-align: center;
    padding: 4rem 2rem;
    color: var(--ink);
}}
.empty-state .hello {{
    font-family: 'Yellowtail', cursive;
    font-size: 3.5rem;
    color: var(--accent);
    display: block;
    margin-bottom: 0.5rem;
}}
.empty-state .subtitle {{
    font-family: 'Special Elite', monospace;
    font-size: 0.9rem;
    opacity: 0.65;
    letter-spacing: 0.1em;
}}

.sparkle {{
    display: inline-block;
    color: var(--accent);
    font-size: 1.2rem;
    animation: spin 8s linear infinite;
}}
@keyframes spin {{
    from {{ transform: rotate(0deg); }}
    to   {{ transform: rotate(360deg); }}
}}

.hero-band {{
    background-color: var(--dark-section);
    background-image: radial-gradient(circle, rgba(255,255,255,0.10) 1px, transparent 1.3px);
    background-size: 6px 6px;
    padding: 2rem 2rem 1.5rem;
    margin: -1rem -1rem 1.5rem;
    border-bottom: 3px solid var(--accent);
    color: #fff;
}}
.hero-band h1 {{
    color: #fff !important;
    margin: 0;
    line-height: 1.1;
}}
.hero-band p {{
    color: rgba(255,255,255,0.75);
    font-family: 'Special Elite', monospace;
    font-size: 0.85rem;
    margin: 0.4rem 0 0;
}}

.page-title {{
    font-family: 'Ultra', serif;
    font-size: 2.8rem;
    text-transform: uppercase;
    color: var(--ink);
    letter-spacing: 0.03em;
    line-height: 1;
    margin: 0;
}}
.section-label {{
    font-family: 'Special Elite', monospace;
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.18em;
    color: var(--ink);
    opacity: 0.55;
    margin-bottom: 0.25rem;
}}

.diary-section-head {{
    font-family: 'Anton', sans-serif;
    font-size: 1.1rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--ink);
    margin: 0.5rem 0 0.75rem;
    border-left: 4px solid var(--accent);
    padding-left: 0.6rem;
}}

/* ── Video sizing — fill column width, cap portrait height ── */
[data-testid="stVideo"] {{
    width: 100% !important;
    max-width: 100% !important;
    padding: 0 !important;
    margin: 0 !important;
    overflow: visible !important;
}}
[data-testid="stVideo"] > div,
[data-testid="stVideo"] > div > div {{
    width: 100% !important;
    padding: 0 !important;
}}
[data-testid="stVideo"] video,
.stVideo video {{
    width: 100% !important;
    max-width: 100% !important;
    max-height: 56vh !important;
    object-fit: contain !important;
    display: block !important;
}}

/* ── Sidebar toggle buttons — Unicode arrows via ::after ──── */
[data-testid="stSidebarCollapseButton"] > button,
[data-testid="stSidebarCollapsedControl"] > button {{
    background-color: var(--accent) !important;
    border: 2px solid rgba(255,255,255,0.6) !important;
    box-shadow: 2px 2px 0 rgba(0,0,0,0.35) !important;
    border-radius: 50% !important;
    width: 32px !important;
    height: 32px !important;
    padding: 0 !important;
    position: relative !important;
    overflow: hidden !important;
    cursor: pointer !important;
    /* block the general button hover transform */
    transform: none !important;
}}
[data-testid="stSidebarCollapseButton"] > button:hover,
[data-testid="stSidebarCollapsedControl"] > button:hover {{
    transform: none !important;
    box-shadow: 3px 3px 0 rgba(0,0,0,0.5) !important;
}}
/* Hide ALL child content (SVG, span, div with Material-icon text) */
[data-testid="stSidebarCollapseButton"] > button *,
[data-testid="stSidebarCollapsedControl"] > button * {{
    visibility: hidden !important;
    font-size: 0 !important;
    width: 0 !important;
    height: 0 !important;
    overflow: hidden !important;
}}
/* Inject ◀ on the collapse (hide-panel) button */
[data-testid="stSidebarCollapseButton"] > button::after {{
    content: '◀' !important;
    visibility: visible !important;
    position: absolute !important;
    top: 50% !important;
    left: 50% !important;
    transform: translate(-50%, -50%) !important;
    color: #fff !important;
    font-size: 13px !important;
    font-family: Arial, Helvetica, sans-serif !important;
    line-height: 1 !important;
    pointer-events: none !important;
    width: auto !important;
    height: auto !important;
}}
/* Inject ▶ on the expand (show-panel) button */
[data-testid="stSidebarCollapsedControl"] > button::after {{
    content: '▶' !important;
    visibility: visible !important;
    position: absolute !important;
    top: 50% !important;
    left: 50% !important;
    transform: translate(-50%, -50%) !important;
    color: #fff !important;
    font-size: 13px !important;
    font-family: Arial, Helvetica, sans-serif !important;
    line-height: 1 !important;
    pointer-events: none !important;
    width: auto !important;
    height: auto !important;
}}
/* Stable sidebar width — no layout shift on text selection */
[data-testid="stSidebar"] {{
    overflow: hidden !important;
}}
[data-testid="stSidebar"] > div:first-child,
section[data-testid="stSidebar"] > div {{
    overflow-x: hidden !important;
}}


/* ── Responsive: stack columns on narrow screens ──────────── */
@media (max-width: 768px) {{
    [data-testid="stHorizontalBlock"] {{
        flex-direction: column !important;
    }}
    [data-testid="stHorizontalBlock"] > [data-testid="stVerticalBlockBorderWrapper"],
    [data-testid="stHorizontalBlock"] > div[data-testid] {{
        width: 100% !important;
        max-width: 100% !important;
        flex: none !important;
    }}
}}
</style>
"""
