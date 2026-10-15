from flask import Blueprint, jsonify, request

from .db import save_link

links = Blueprint("links", __name__)


@links.post("/links")
def create_link():
    url = request.json["url"]
    link = save_link(url)
    return jsonify({"id": link.id, "url": link.url}), 201
