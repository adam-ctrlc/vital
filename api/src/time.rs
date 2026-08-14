use chrono::{DateTime, FixedOffset, Utc};

/// Philippine time (UTC+8). Fixed offset: the country does not observe DST.
const LOCAL_OFFSET_SECONDS: i32 = 8 * 3600;
const LOCAL_LABEL_FORMAT: &str = "%B %-d, %Y %-I:%M %p";

/// Renders an instant in local time for people; the raw value stays UTC for machines.
#[must_use]
pub fn local_label(at: DateTime<Utc>) -> String {
    FixedOffset::east_opt(LOCAL_OFFSET_SECONDS).map_or_else(
        || at.format(LOCAL_LABEL_FORMAT).to_string(),
        |offset| {
            at.with_timezone(&offset)
                .format(LOCAL_LABEL_FORMAT)
                .to_string()
        },
    )
}
