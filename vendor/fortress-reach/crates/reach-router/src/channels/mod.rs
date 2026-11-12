pub mod github;
pub mod reddit;
pub mod rss;
pub mod search;
pub mod twitter;
pub mod web;
pub mod youtube;

pub use github::GitHubChannel;
pub use reddit::RedditChannel;
pub use rss::RssChannel;
pub use search::SearchChannel;
pub use twitter::TwitterChannel;
pub use web::WebChannel;
pub use youtube::YouTubeChannel;
