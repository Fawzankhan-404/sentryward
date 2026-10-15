import pytest

from app.slug import slugify


@pytest.mark.parametrize(
    "text, expected",
    [
        ("Hello World", "hello-world"),
        ("  Leading and trailing  ", "leading-and-trailing"),
        ("Crème brûlée", "creme-brulee"),
        ("a--b__c", "a-b-c"),
        ("", ""),
    ],
)
def test_slugify(text, expected):
    assert slugify(text) == expected


def test_slugify_truncates_without_trailing_dash():
    assert slugify("word " * 20, max_length=12) == "word-word-wo"
    assert not slugify("ab cd ef", max_length=3).endswith("-")
