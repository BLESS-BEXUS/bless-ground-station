# Map tiles

These PNG tiles are a cache of the OpenStreetMap standard layer around Esrange (Kiruna, Sweden),
kept in the repository so the map works offline after a plain `git clone` / `git pull`.

Map data © OpenStreetMap contributors, available under the Open Database License (ODbL):
https://www.openstreetmap.org/copyright

The backend serves them as `/tiles/{z}/{x}/{y}.png`. Tiles that are not here are downloaded from
OpenStreetMap the first time they are viewed (when there is internet) and added to this folder.
See "Offline map tiles" in `backend/README.md`.
