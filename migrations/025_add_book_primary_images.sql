CREATE TABLE book_primary_images (
    book_id INTEGER PRIMARY KEY,
    asset_id INTEGER NOT NULL,
    FOREIGN KEY (book_id) REFERENCES books(id) ON DELETE CASCADE,
    FOREIGN KEY (asset_id) REFERENCES assets(id) ON DELETE CASCADE
);

CREATE INDEX idx_book_primary_images_asset_id
    ON book_primary_images(asset_id);
