// src-tauri/src/markdown_parser.rs
use pulldown_cmark::{html, Event, Options, Parser};

fn escape_html_attribute(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&#39;")
}

#[tauri::command]
pub fn markdown_to_html(markdown: String) -> Result<String, String> {
    let mut options = Options::empty();
    options.insert(Options::ENABLE_TABLES);
    options.insert(Options::ENABLE_FOOTNOTES);
    options.insert(Options::ENABLE_TASKLISTS);
    options.insert(Options::ENABLE_STRIKETHROUGH);
    options.insert(Options::ENABLE_MATH);
    options.insert(Options::ENABLE_HEADING_ATTRIBUTES);
    options.insert(Options::ENABLE_GFM);

    let parser = Parser::new_ext(&markdown, options);

    // Intercept Math events and convert them to KaTeX/MathJax DOM containers
    let event_stream = parser.map(|event| match event {
        Event::InlineMath(content) => {
            let attr = escape_html_attribute(&content);
            Event::Html(format!("<span class=\"math inline\" data-math=\"{attr}\">\\({content}\\)</span>").into())
        }
        Event::DisplayMath(content) => {
            let attr = escape_html_attribute(&content);
            Event::Html(format!("<div class=\"math display\" data-math=\"{attr}\">\\[{content}\\]</div>").into())
        }
        other => other,
    });

    let mut html_output = String::with_capacity(markdown.len() * 3 / 2);
    html::push_html(&mut html_output, event_stream);

    Ok(html_output)
}
